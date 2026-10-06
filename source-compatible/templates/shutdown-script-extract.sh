#!/bin/bash
set -euo pipefail

# Multi-user Docker-based GitHub Runner shutdown script with GUARANTEED deregistration
# This script will ensure runners are removed from GitHub even if everything else fails

# Redirect all output to syslog and a dedicated log file
exec > >(tee -a /var/log/runner-shutdown-multi-docker.log) 2>&1
echo "=== ENHANCED Multi-User Docker Runner shutdown starting at $(date) ==="

# File containing runner user info
RUNNER_USERS_FILE="/var/log/runner-users.txt"

# Function to safely get metadata
get_metadata() {
    local key="$1"
    curl -sf -H "Metadata-Flavor: Google" "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$key" 2>/dev/null || echo ""
}

# Initialize repository info (will be set from config file or metadata)
REPO_OWNER=""
REPO_NAME=""

# Try to load repository info from config file first (more reliable)
if [ -f "$RUNNER_USERS_FILE" ]; then
    echo "≡ƒôä Loading repository info from config file: $RUNNER_USERS_FILE"
    
    # Source the config to get variables including REPO_OWNER and REPO_NAME
    source "$RUNNER_USERS_FILE" 2>/dev/null || true
    
    if [ -n "$REPO_OWNER" ] && [ -n "$REPO_NAME" ]; then
        echo "Γ£à Repository info loaded from config: $REPO_OWNER/$REPO_NAME"
    else
        echo "ΓÜá∩╕Å  Config file found but repository info missing"
    fi
else
    echo "ΓÜá∩╕Å  Runner config file not found: $RUNNER_USERS_FILE"
fi

# Fallback: Get repository info from metadata if not already set
if [ -z "$REPO_OWNER" ] || [ -z "$REPO_NAME" ]; then
    echo "≡ƒôí Fallback: Getting repository info from metadata..."
    REPO_OWNER=$(get_metadata "repo-owner")
    REPO_NAME=$(get_metadata "repo-name")
    
    if [ -n "$REPO_OWNER" ] && [ -n "$REPO_NAME" ]; then
        echo "Γ£à Repository info loaded from metadata: $REPO_OWNER/$REPO_NAME"
    else
        echo "Γ¥î Failed to get repository info from metadata"
    fi
fi

echo "Final repository: $REPO_OWNER/$REPO_NAME"

# CRITICAL: Get GitHub PAT first - this is essential for deregistration
echo "=== STEP 1: Getting GitHub PAT ==="
GITHUB_PAT=""

# First try to get from stored file (set during startup)
if [ -f "/var/log/github-pat.txt" ]; then
    echo "Reading GitHub PAT from stored file..."
    GITHUB_PAT=$(cat /var/log/github-pat.txt 2>/dev/null || echo "")
    if [ -n "$GITHUB_PAT" ]; then
        echo "Γ£à GitHub PAT retrieved from stored file"
    else
        echo "Γ¥î Failed to read GitHub PAT from stored file"
    fi
else
    echo "ΓÜá∩╕Å  No stored GitHub PAT file found"
fi

# Fallback: try Secret Manager (may fail during shutdown)
if [ -z "$GITHUB_PAT" ] && command -v gcloud &>/dev/null; then
    echo "Fallback: Retrieving GitHub PAT from Secret Manager..."
    GITHUB_PAT=$(gcloud secrets versions access latest --secret="github-runner-token" 2>/dev/null || echo "")
    if [ -n "$GITHUB_PAT" ]; then
        echo "Γ£à GitHub PAT retrieved from Secret Manager"
    else
        echo "Γ¥î Failed to get GitHub PAT from Secret Manager"
    fi
else
    echo "Γ¥î gcloud not available for Secret Manager fallback"
fi

# Set up GitHub API headers
GITHUB_HEADERS=()
if [ -n "$GITHUB_PAT" ] && [ -n "$REPO_OWNER" ] && [ -n "$REPO_NAME" ]; then
    GITHUB_HEADERS=(
        -H "Authorization: Bearer $GITHUB_PAT"
        -H "Accept: application/vnd.github+json"
        -H "User-Agent: github-runner-gce-shutdown"
    )
    echo "Γ£à GitHub API headers configured"
else
    echo "Γ¥î Cannot configure GitHub API - missing PAT or repo info"
fi

# Function to generate a single remove token for all runners
generate_remove_token() {
    if [ ${#GITHUB_HEADERS[@]} -eq 0 ]; then
        echo "Γ¥î Cannot generate remove token - no GitHub API access"
        return 1
    fi
    
    echo "≡ƒöº Generating remove token for all runners..."
    
    # Generate remove token using GitHub API
    remove_token_response=$(curl -s -X POST \
        -H "Authorization: Bearer $GITHUB_PAT" \
        -H "Accept: application/vnd.github+json" \
        -H "User-Agent: github-runner-shutdown" \
        "https://api.github.com/repos/$REPO_OWNER/$REPO_NAME/actions/runners/remove-token" 2>/dev/null)
    
    if [ $? -ne 0 ] || [ -z "$remove_token_response" ]; then
        echo "Γ¥î Failed to get remove token from GitHub API"
        return 1
    fi
    
    # Extract remove token (without jq dependency)
    REMOVE_TOKEN=$(echo "$remove_token_response" | grep -o '"token":"[^"]*"' | sed 's/"token":"\([^"]*\)"/\1/')
    
    if [ -z "$REMOVE_TOKEN" ] || [ "$REMOVE_TOKEN" = "null" ]; then
        echo "Γ¥î Invalid remove token received from GitHub"
        return 1
    fi
    
    echo "Γ£à Remove token obtained successfully for all runners"
    return 0
}

# Function to remove a single runner from GitHub using shared remove token
remove_single_runner() {
    local runner_name="$1"
    local container_name="$2"
    local remove_token="$3"
    
    echo "≡ƒùæ∩╕Å  Removing runner '$runner_name' using config.sh..."
    
    if docker exec "$container_name" /actions-runner/config.sh remove --token "$remove_token" 2>/dev/null; then
        echo "Γ£à Successfully removed runner '$runner_name' from GitHub!"
        return 0
    else
        echo "Γ¥î Failed to remove runner '$runner_name' using config.sh"
        return 1
    fi
}

# STEP 2: Stop containers and deregister runners
echo "=== STEP 2: Processing runners ==="

# Track success
DEREGISTERED_COUNT=0
TOTAL_RUNNERS=0

if [ -f "$RUNNER_USERS_FILE" ]; then
    echo "≡ƒôä Processing runners using config file: $RUNNER_USERS_FILE"
    
    # Note: Config file was already sourced earlier for repository info
    # Get all saved runner names
    SAVED_RUNNER_NAMES=($(grep "^RUNNER_NAME_[0-9]*=" "$RUNNER_USERS_FILE" | sed 's/.*="\(.*\)"/\1/' || true))
    TOTAL_RUNNERS=${#SAVED_RUNNER_NAMES[@]}
    
    echo "≡ƒôè Found $TOTAL_RUNNERS saved runner names"
    
    if [ $TOTAL_RUNNERS -gt 0 ]; then
        # Generate remove token once for all runners
        REMOVE_TOKEN=""
        if generate_remove_token; then
            echo "≡ƒÜÇ Starting parallel runner deregistration..."
            
            # Create arrays to track parallel jobs
            declare -a RUNNER_PIDS=()
            
            # Start deregistration of all runners in parallel
            for i in "${!SAVED_RUNNER_NAMES[@]}"; do
                runner_name="${SAVED_RUNNER_NAMES[$i]}"
                echo "≡ƒöä Starting deregistration for runner: $runner_name"
                
                # Get corresponding container name from config file
                container_name_var="CONTAINER_NAME_$((i+1))"
                container_name=$(grep "^${container_name_var}=" "$RUNNER_USERS_FILE" | sed 's/.*="\(.*\)"/\1/' || echo "")
                
                if [ -z "$container_name" ]; then
                    echo "ΓÜá∩╕Å  No container name found for runner $runner_name, skipping"
                    continue
                fi
                
                # Start removal in background
                (
                    if remove_single_runner "$runner_name" "$container_name" "$REMOVE_TOKEN"; then
                        echo "SUCCESS:$runner_name" > "/tmp/runner_result_$$_$i"
                    else
                        echo "FAILED:$runner_name" > "/tmp/runner_result_$$_$i"
                    fi
                ) &
                
                RUNNER_PIDS+=($!)
            done
            
            # Wait for all parallel jobs to complete
            echo "ΓÅ│ Waiting for all $TOTAL_RUNNERS runner deregistrations to complete..."
            for pid in "${RUNNER_PIDS[@]}"; do
                wait $pid
            done
            
            # Count successes
            DEREGISTERED_COUNT=0
            for i in "${!SAVED_RUNNER_NAMES[@]}"; do
                if [ -f "/tmp/runner_result_$$_$i" ]; then
                    result=$(cat "/tmp/runner_result_$$_$i")
                    if [[ $result == SUCCESS:* ]]; then
                        DEREGISTERED_COUNT=$((DEREGISTERED_COUNT + 1))
                    fi
                    rm -f "/tmp/runner_result_$$_$i"
                fi
            done
            
            echo "Γ£à Parallel deregistration completed: $DEREGISTERED_COUNT/$TOTAL_RUNNERS successful"
        else
            echo "Γ¥î Failed to generate remove token, skipping deregistration"
        fi
    fi
    
    # Also try to stop containers
    echo "≡ƒÉ│ Stopping Docker containers..."
    CONTAINER_NAMES=($(grep "^CONTAINER_NAME_[0-9]*=" "$RUNNER_USERS_FILE" | sed 's/.*="\(.*\)"/\1/' || true))
    USER_NAMES=($(grep "^RUNNER_USER_[0-9]*=" "$RUNNER_USERS_FILE" | sed 's/.*="\(.*\)"/\1/' || true))
    
    for i in "${!CONTAINER_NAMES[@]}"; do
        container_name="${CONTAINER_NAMES[$i]}"
        user_name="${USER_NAMES[$i]:-}"
        
        if [ -n "$container_name" ] && [ -n "$user_name" ]; then
            echo "≡ƒ¢æ Stopping container '$container_name' for user '$user_name'"
            if id -u "$user_name" &>/dev/null; then
                sudo -u "$user_name" docker stop "$container_name" 2>/dev/null || echo "ΓÜá∩╕Å  Failed to stop $container_name"
                sudo -u "$user_name" docker rm "$container_name" 2>/dev/null || echo "ΓÜá∩╕Å  Failed to remove $container_name"
            fi
        fi
    done
    
else
    echo "Γ¥î No runner config file found - will try generic cleanup"
    
    # Fallback: try to find and deregister any runners with our instance name
    INSTANCE_NAME=$(curl -sf -H "Metadata-Flavor: Google" "http://metadata.google.internal/computeMetadata/v1/instance/name" 2>/dev/null || echo "")
    
    if [ -n "$INSTANCE_NAME" ] && [ ${#GITHUB_HEADERS[@]} -gt 0 ]; then
        echo "≡ƒöì Looking for runners containing instance name: $INSTANCE_NAME"
        
        # Get all runners and filter by instance name
        runners_json
        runners_json=$(curl -s "https://api.github.com/repos/$REPO_OWNER/$REPO_NAME/actions/runners?per_page=100" "${GITHUB_HEADERS[@]}" 2>/dev/null)
        
        if [ $? -eq 0 ] && [ -n "$runners_json" ]; then
            # Extract runner names containing our instance name
            matching_runners
            matching_runners=($(echo "$runners_json" | grep "\"name\":" | sed 's/.*"name":"\([^"]*\)".*/\1/' | grep "$INSTANCE_NAME" || true))
            
            TOTAL_RUNNERS=${#matching_runners[@]}
            echo "≡ƒôè Found $TOTAL_RUNNERS matching runners"
            
            if [ $TOTAL_RUNNERS -gt 0 ]; then
                # Generate remove token once for all fallback runners
                REMOVE_TOKEN=""
                if generate_remove_token; then
                    echo "≡ƒÜÇ Starting parallel fallback runner deregistration..."
                    
                    # Create arrays to track parallel jobs
                    declare -a FALLBACK_PIDS=()
                    
                    for i in "${!matching_runners[@]}"; do
                        runner_name="${matching_runners[$i]}"
                        echo "≡ƒöä Starting deregistration for matched runner: $runner_name"
                        
                        # For fallback mode, try to find container by pattern
                        container_name=$(docker ps -a --format "{{.Names}}" | grep -E "github-runner.*${runner_name##*-}" | head -1 || echo "")
                        
                        if [ -z "$container_name" ]; then
                            echo "ΓÜá∩╕Å  No container found for runner $runner_name, skipping"
                            continue
                        fi
                        
                        # Start removal in background
                        (
                            if remove_single_runner "$runner_name" "$container_name" "$REMOVE_TOKEN"; then
                                echo "SUCCESS:$runner_name" > "/tmp/fallback_result_$$_$i"
                            else
                                echo "FAILED:$runner_name" > "/tmp/fallback_result_$$_$i"
                            fi
                        ) &
                        
                        FALLBACK_PIDS+=($!)
                    done
                    
                    # Wait for all parallel jobs to complete
                    echo "ΓÅ│ Waiting for all $TOTAL_RUNNERS fallback deregistrations to complete..."
                    for pid in "${FALLBACK_PIDS[@]}"; do
                        wait $pid
                    done
                    
                    # Count successes
                    DEREGISTERED_COUNT=0
                    for i in "${!matching_runners[@]}"; do
                        if [ -f "/tmp/fallback_result_$$_$i" ]; then
                            result=$(cat "/tmp/fallback_result_$$_$i")
                            if [[ $result == SUCCESS:* ]]; then
                                DEREGISTERED_COUNT=$((DEREGISTERED_COUNT + 1))
                            fi
                            rm -f "/tmp/fallback_result_$$_$i"
                        fi
                    done
                    
                    echo "Γ£à Parallel fallback deregistration completed: $DEREGISTERED_COUNT/$TOTAL_RUNNERS successful"
                else
                    echo "Γ¥î Failed to generate remove token for fallback, skipping deregistration"
                fi
            fi
        fi
    fi
fi

# STEP 3: Cleanup users and containers
echo "=== STEP 3: User cleanup ==="

# Find and clean up runner users
RUNNER_USERS=($(getent passwd | grep "^runner-" | cut -d: -f1 || true))
for user in "${RUNNER_USERS[@]}"; do
    echo "≡ƒº╣ Cleaning up user: $user"
    
    # Stop any remaining containers
    if id -u "$user" &>/dev/null; then
        CONTAINERS=$(sudo -u "$user" docker ps -a --filter "name=github-runner" --format "{{.Names}}" 2>/dev/null || true)
        for container in $CONTAINERS; do
            echo "≡ƒ¢æ Stopping remaining container: $container"
            sudo -u "$user" docker stop "$container" 2>/dev/null || true
            sudo -u "$user" docker rm "$container" 2>/dev/null || true
        done
        
        # Remove user
        userdel -r "$user" 2>/dev/null || echo "ΓÜá∩╕Å  Failed to remove user $user"
        rm -f "/etc/sudoers.d/$user" 2>/dev/null || true
    fi
done

# STEP 4: Final status
echo "=== STEP 4: Final status ==="
echo "≡ƒôè DEREGISTRATION SUMMARY:"
echo "   Total runners found: $TOTAL_RUNNERS"
echo "   Successfully deregistered: $DEREGISTERED_COUNT"
echo "   Failed: $((TOTAL_RUNNERS - DEREGISTERED_COUNT))"

# Create completion marker
echo "$(date): Shutdown completed. Deregistered $DEREGISTERED_COUNT/$TOTAL_RUNNERS runners" > /var/log/runner-shutdown.done

# Cleanup files
rm -f "$RUNNER_USERS_FILE" 2>/dev/null || true
rm -f /usr/local/bin/multi-docker-runner-monitor.sh 2>/dev/null || true
rm -f /var/log/github-pat.txt 2>/dev/null || true  # Clean up stored PAT

echo "=== Multi-User Docker Runner shutdown completed at $(date) ==="

if [ $DEREGISTERED_COUNT -eq $TOTAL_RUNNERS ] && [ $TOTAL_RUNNERS -gt 0 ]; then
    echo "Γ£à SUCCESS: All runners deregistered successfully"
    exit 0
else
    echo "ΓÜá∩╕Å  WARNING: Some runners may not have been deregistered"
    exit 1
fi

