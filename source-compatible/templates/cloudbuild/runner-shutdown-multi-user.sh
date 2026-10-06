#!/bin/bash
set -euo pipefail

# Shutdown is retryable: failed remote removal retains the manifest and local state.
MODE=native
metadata() {
    curl -fsS --connect-timeout 3 --max-time 10 -H 'Metadata-Flavor: Google' \
        "http://metadata.google.internal/computeMetadata/v1/instance/$1" 2>/dev/null || true
}
manifest_value() {
    sed -n "s/^$1=\"\\([^\"]*\\)\"$/\\1/p" "$RUNNER_USERS_FILE" | head -n 1
}
record_value() {
    local key="$1" value="$2" tmp
    tmp=$(mktemp "${RUNNER_USERS_FILE}.XXXXXX") || return 1
    if ! { sed "/^${key}=/d" "$RUNNER_USERS_FILE" > "$tmp" &&
           printf '%s="%s"\n' "$key" "$value" >> "$tmp" &&
           chmod 600 "$tmp"; }; then
        rm -f "$tmp"
        return 1
    fi
    if ! mv "$tmp" "$RUNNER_USERS_FILE"; then rm -f "$tmp"; return 1; fi
}
# One validated, paginated snapshot; malformed/error/ambiguous responses fail closed.
list_runners() {
    local page=1 body code count total initial_total='' seen=0 all='[]'
    body=$(mktemp)
    while [ "$page" -le 100 ]; do
        if ! code=$(curl -sS --connect-timeout 3 --max-time 15 -o "$body" -w '%{http_code}' \
            -H "Authorization: Bearer $GITHUB_PAT" -H 'Accept: application/vnd.github+json' \
            "https://api.github.com/repos/$REPO_OWNER/$REPO_NAME/actions/runners?per_page=100&page=$page"); then
            rm -f "$body"; return 1
        fi
        if [ "$code" != 200 ] || ! jq -e '
            (.total_count | type == "number") and (.total_count >= 0) and (.total_count == (.total_count | floor)) and
            (.runners | type == "array") and all(.runners[];
                (.id | type == "number") and (.id > 0) and (.id == (.id | floor)) and
                (.name | type == "string") and (.busy | type == "boolean"))' "$body" >/dev/null; then
            rm -f "$body"; return 1
        fi
        count=$(jq '.runners | length' "$body")
        total=$(jq '.total_count' "$body")
        if [ -n "$initial_total" ] && [ "$total" -ne "$initial_total" ]; then rm -f "$body"; return 1; fi
        initial_total=$total
        all=$(jq -cn --argjson all "$all" --argjson next "$(jq '.runners' "$body")" '$all + $next')
        seen=$((seen + count))
        if [ "$count" -lt 100 ]; then
            rm -f "$body"
            [ "$seen" -eq "$total" ] || return 1
            # Duplicate IDs/names mean lookup is ambiguous or pagination changed.
            jq -e 'length == (map(.id) | unique | length) and length == (map(.name) | unique | length)' <<< "$all" >/dev/null || return 1
            printf '%s\n' "$all"; return 0
        fi
        page=$((page + 1))
    done
    rm -f "$body"; return 1
}
remove_runner() {
    local name="$1" runner_id busy code
    runner_id=$(jq -r --arg name "$name" '.[] | select(.name == $name) | .id' <<< "$RUNNERS_JSON")
    [ -n "$runner_id" ] || return 0 # Valid complete inventory proves already absent.
    busy=$(jq -r --arg name "$name" '.[] | select(.name == $name) | .busy' <<< "$RUNNERS_JSON")
    [ "$busy" = false ] || return 1
    record_value "RUNNER_ID_$INDEX" "$runner_id" || return 1
    code=$(curl -sS --connect-timeout 3 --max-time 15 -o /dev/null -w '%{http_code}' -X DELETE \
        -H "Authorization: Bearer $GITHUB_PAT" -H 'Accept: application/vnd.github+json' \
        "https://api.github.com/repos/$REPO_OWNER/$REPO_NAME/actions/runners/$runner_id") || return 1
    # Called only during VM teardown; not an atomic drain barrier for live VMs.
    [ "$code" = 204 ] || [ "$code" = 404 ]
}
recover_container() {
    local name="$1" candidate candidates inspected found=""
    candidates=$(docker ps -a --format '{{.Names}}') || return 1
    for candidate in $candidates; do
        inspected=$(docker inspect "$candidate") || return 1
        jq -e 'type == "array" and length == 1 and (.[0].Config.Env | type == "array")' <<< "$inspected" >/dev/null || return 1
        if jq -e --arg name "$name" 'any(.[].Config.Env[]?; . == ("RUNNER_NAME=" + $name))' <<< "$inspected" >/dev/null; then
            [ -z "$found" ] || return 1
            found=$candidate
        fi
    done
    printf '%s\n' "$found"
}
local_teardown() {
    local user="$1" container="$2"
    if [ "$MODE" = native ] && [ -n "$user" ] && [ -d "/home/$user/actions-runner" ]; then
        # Remote removal already succeeded. Service absence cannot suppress it.
        (cd "/home/$user/actions-runner"; sudo ./svc.sh stop || true; sudo ./svc.sh uninstall || true)
    fi
    if [ "$MODE" = docker ]; then
        listed=$(docker ps -a --format '{{.Names}}') || return 1
        if [ -n "$container" ] && printf '%s\n' "$listed" | grep -Fxq "$container"; then
            docker inspect "$container" >/dev/null 2>&1 || return 1
            docker update --restart=no "$container" >/dev/null 2>&1 || return 1
            docker stop --time 20 "$container" >/dev/null 2>&1 || return 1
            docker rm "$container" >/dev/null 2>&1 || return 1
        fi
    fi
    if [ -n "$user" ] && id -u "$user" >/dev/null 2>&1; then
        userdel -r "$user" >/dev/null 2>&1 || return 1
        rm -f "/etc/sudoers.d/$user"
    fi
}
shutdown_main() {
    RUNNER_USERS_FILE="/var/log/runner-users.txt"
    # Startup and teardown share a lock. Monitor children must close fd 9.
    exec 9>/var/run/runner-lifecycle.lock
    flock -w 30 9 || return 1
    touch /var/log/runner-draining
    REPO_OWNER="" REPO_NAME=""
    if [ -f "$RUNNER_USERS_FILE" ]; then
        REPO_OWNER=$(manifest_value REPO_OWNER)
        REPO_NAME=$(manifest_value REPO_NAME)
    fi
    REPO_OWNER=${REPO_OWNER:-$(metadata attributes/repo-owner)}
    REPO_NAME=${REPO_NAME:-$(metadata attributes/repo-name)}
    INSTANCE_NAME=$(metadata name)
    [ -n "$INSTANCE_NAME" ] || return 1
    if [ -f /var/log/github-pat.txt ]; then GITHUB_PAT=$(cat /var/log/github-pat.txt); else GITHUB_PAT=""; fi
    GITHUB_PAT=${GITHUB_PAT:-$(gcloud secrets versions access latest --secret=github-runner-token 2>/dev/null || true)}
    [ -n "$GITHUB_PAT" ] && [ -n "$REPO_OWNER" ] && [ -n "$REPO_NAME" ] || return 1
    RUNNERS_JSON=$(list_runners) || return 1
    if [ "$MODE" = native ] && [ -f "$RUNNER_USERS_FILE" ]; then
        # Legacy native startup persisted users only. Recover exact registration
        # identities from each user's structural .runner configuration.
        for INDEX in $(sed -n 's/^RUNNER_USER_\([0-9][0-9]*\)=.*/\1/p' "$RUNNER_USERS_FILE" | sort -nu); do
            if [ -z "$(manifest_value "RUNNER_NAME_$INDEX")" ]; then
                user=$(manifest_value "RUNNER_USER_$INDEX")
                config="/home/$user/actions-runner/.runner"
                name=$(jq -er '.agentName | select(type == "string")' "$config") || return 1
                runner_id=$(jq -er '.agentId | select(type == "number" and . > 0 and . == floor)' "$config") || return 1
                record_value "RUNNER_NAME_$INDEX" "$name"
                record_value "RUNNER_ID_$INDEX" "$runner_id"
            fi
        done
    fi
    if [ ! -f "$RUNNER_USERS_FILE" ]; then
        # Exact ownership pattern supports current and legacy identities, never substrings.
        names=$(jq -r --arg vm "$INSTANCE_NAME" '.[] | select(.name | startswith($vm + "-")) | .name' <<< "$RUNNERS_JSON")
        : > "$RUNNER_USERS_FILE"; chmod 600 "$RUNNER_USERS_FILE"
        record_value REPO_OWNER "$REPO_OWNER"; record_value REPO_NAME "$REPO_NAME"
        n=0
        while IFS= read -r name; do
            suffix=${name#"$INSTANCE_NAME"-}
            if [[ "$suffix" =~ ^(runner|[a-f0-9]{8})-[0-9]+$ ]]; then
                n=$((n + 1)); record_value "RUNNER_NAME_$n" "$name"

            fi
        done <<< "$names"
    fi
    indexes=$(sed -n 's/^RUNNER_NAME_\([0-9][0-9]*\)=.*/\1/p' "$RUNNER_USERS_FILE" | sort -nu)
    [ -n "$indexes" ] || return 1 # Missing manifest + no matches is unknown, not success.
    failed=0
    for INDEX in $indexes; do
        name=$(manifest_value "RUNNER_NAME_$INDEX")
        suffix=${name#"$INSTANCE_NAME"-}
        if [ "$suffix" = "$name" ] || ! [[ "$suffix" =~ ^(runner|[a-f0-9]{8})-[0-9]+$ ]]; then
            failed=1; continue
        fi
        user=$(manifest_value "RUNNER_USER_$INDEX")
        container=$(manifest_value "CONTAINER_NAME_$INDEX")
        if [ "$MODE" = docker ] && [ -z "$container" ]; then
            # Recover partial fallback manifests on every retry, not only first use.
            if ! container=$(recover_container "$name"); then failed=1; continue; fi
            record_value "CONTAINER_NAME_$INDEX" "$container" || return 1
        fi
        if remove_runner "$name" && local_teardown "$user" "$container"; then
            record_value "CLEANED_$INDEX" yes
        else
            failed=1
        fi
    done
    [ "$failed" -eq 0 ] || return 1
    # A second fresh inventory catches re-registration or pagination changes.
    RUNNERS_JSON=$(list_runners) || return 1
    for INDEX in $indexes; do
        name=$(manifest_value "RUNNER_NAME_$INDEX")
        jq -e --arg name "$name" 'all(.[]; .name != $name)' <<< "$RUNNERS_JSON" >/dev/null || return 1
    done
    if [ "$MODE" = docker ]; then
        # Unexpected managed containers mean local retry state is incomplete.
        remaining=$(docker ps -a --filter name=github-runner --format '{{.Names}}') || return 1
        [ -z "$remaining" ] || return 1
    fi
    # Never certify absent-manifest native state: unknown services may still run.
    if [ "$MODE" = native ]; then
        for INDEX in $indexes; do
            [ -n "$(manifest_value "RUNNER_USER_$INDEX")" ] || return 1
        done
    fi
    # Prove no owned registration remains beyond the names in a partial manifest.
    jq -e --arg vm "$INSTANCE_NAME" 'all(.[]; (.name | startswith($vm + "-")) | not)' <<< "$RUNNERS_JSON" >/dev/null || return 1
    record_value CLEANUP_COMPLETE yes || return 1
    zone=$(metadata zone); zone=${zone##*/}
    incarnation=$(metadata id)
    [ -n "$zone" ] && [ -n "$incarnation" ] || return 1
    gcloud compute instances add-metadata "$INSTANCE_NAME" --zone="$zone" \
        --metadata="runner-cleanup-ready=$incarnation" --quiet || return 1
    echo 'All runner registrations and local resources removed; manifest retained for retry proof.'
}
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    exec > >(tee -a /var/log/runner-shutdown.log) 2>&1
    shutdown_main
fi
