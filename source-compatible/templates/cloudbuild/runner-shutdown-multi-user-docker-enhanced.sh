#!/bin/bash
set -euo pipefail

# Enhanced Multi-User Docker Runner Shutdown Script with Cloud Function Backup
# This script attempts local cleanup and triggers Cloud Function cleanup as backup

exec > >(tee -a /var/log/runner-shutdown-multi-docker-enhanced.log) 2>&1
echo "=== Enhanced Multi-User Docker Runner shutdown starting at $(date) ==="

RUNNER_USERS_FILE="/var/log/runner-users.txt"
PAT_FILE="/var/log/github-pat.txt"
LOG_FILE="/var/log/runner-shutdown-multi-docker-enhanced.log"

# Function to send cleanup request to Cloud Function
trigger_cloud_function_cleanup() {
    local instance_name="$1"
    local runner_names=("${@:2}")
    
    echo "Triggering Cloud Function cleanup as backup..."
    
    # Get project ID and cleanup topic from metadata
    local project_id
    project_id=$(curl -s -H "Metadata-Flavor: Google" \
        "http://metadata.google.internal/computeMetadata/v1/project/project-id" 2>/dev/null || echo "")
    
    local cleanup_topic
    cleanup_topic=$(curl -s -H "Metadata-Flavor: Google" \
        "http://metadata.google.internal/computeMetadata/v1/instance/attributes/cleanup-pubsub-topic" 2>/dev/null || echo "hybrid-cleanup-events")
    
    if [ -z "$project_id" ]; then
        echo "Warning: Could not get project ID for Cloud Function trigger"
        return 1
    fi
    
    # Create cleanup message
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    
    local cleanup_message
    cleanup_message=$(cat <<EOF
{
  "triggerType": "vm_shutdown",
  "instanceName": "$instance_name",
  "runnerNames": [$(printf '"%s",' "${runner_names[@]}" | sed 's/,$//')],,
  "timestamp": "$timestamp",
  "source": "enhanced-shutdown-script",
  "projectId": "$project_id"
}
EOF
)
    
    echo "Sending cleanup message to topic: $cleanup_topic"
    echo "Message: $cleanup_message"
    
    # Try to publish to Pub/Sub topic
    if command -v gcloud >/dev/null 2>&1; then
        if echo "$cleanup_message" | gcloud pubsub topics publish "$cleanup_topic" --message=- 2>/dev/null; then
            echo "✅ Successfully triggered Cloud Function cleanup"
            return 0
        else
            echo "⚠️  Failed to publish to Pub/Sub topic"
        fi
    else
        echo "⚠️  gcloud command not available for Cloud Function trigger"
    fi
    
    # Alternative: try HTTP trigger if available
    echo "Attempting alternative Cloud Function trigger methods..."
    return 1
}

# Function to check if we're in a preemption scenario
is_preemption() {
    # Check if this is a preemption by looking for preemption signals
    if [ -f /var/lib/cloud/instance/boot-finished ]; then
        # Check metadata for preemption notice
        local preemption_notice
        preemption_notice=$(curl -s -H "Metadata-Flavor: Google" \
            "http://metadata.google.internal/computeMetadata/v1/instance/preempted" 2>/dev/null || echo "FALSE")
        
        if [ "$preemption_notice" = "TRUE" ]; then
            return 0
        fi
    fi
    
    # Check for common preemption indicators
    if pgrep -f "preemption" >/dev/null 2>&1; then
        return 0
    fi
    
    return 1
}

# Function to get metadata with error handling
get_metadata() {
    local key="$1"
    local default_value="${2:-}"
    
    local value
    value=$(curl -s --connect-timeout 3 --max-time 10 \
        -H "Metadata-Flavor: Google" \
        "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$key" 2>/dev/null || echo "")
    
    if [ -z "$value" ] || [ "$value" = "Not Found" ]; then
        echo "$default_value"
    else
        echo "$value"
    fi
}

# Function to remove runner from GitHub using proper remove token
remove_runner_from_github() {
    local runner_name="$1"
    local github_pat="$2"
    local container_name="$3"
    
    echo "Attempting to remove runner: $runner_name"
    
    # Get repository info
    local repo_owner
    local repo_name
    repo_owner=$(get_metadata "repo-owner" "PARITY_INPUT_010")
    repo_name=$(get_metadata "repo-name" "VeraID")
    
    echo "Repository: $repo_owner/$repo_name"
    
    # Generate remove token using GitHub API
    echo "🔑 Generating remove token for runner '$runner_name'..."
    local remove_token_response
    if ! remove_token_response=$(curl -s --connect-timeout 10 --max-time 30 -X POST \
        -H "Authorization: Bearer $github_pat" \
        -H "Accept: application/vnd.github+json" \
        -H "User-Agent: enhanced-shutdown-script" \
        "https://api.github.com/repos/$repo_owner/$repo_name/actions/runners/remove-token" 2>&1); then
        echo "❌ Failed to get remove token: $remove_token_response"
        return 1
    fi
    
    # Check for API errors
    if echo "$remove_token_response" | grep -q '"message"'; then
        local error_msg
        error_msg=$(echo "$remove_token_response" | grep -o '"message":"[^"]*"' | head -1 | cut -d'"' -f4)
        echo "❌ GitHub API error: $error_msg"
        return 1
    fi
    
    # Extract remove token (without jq dependency)
    local remove_token
    remove_token=$(echo "$remove_token_response" | grep -o '"token":"[^"]*"' | sed 's/"token":"\([^"]*\)"/\1/')
    
    if [ -z "$remove_token" ] || [ "$remove_token" = "null" ]; then
        echo "❌ Invalid remove token received from GitHub"
        return 1
    fi
    
    echo "✅ Remove token obtained successfully"
    
    # Use remove token with config.sh remove inside the container
    echo "🗑️  Removing runner '$runner_name' using config.sh..."
    
    if sudo -u "$RUNNER_USER" docker exec "$container_name" /actions-runner/config.sh remove --token "$remove_token" 2>/dev/null; then
        echo "✅ Successfully removed runner '$runner_name' from GitHub!"
        return 0
    else
        echo "❌ Failed to remove runner '$runner_name' using config.sh"
        return 1
    fi
}

# Main shutdown logic
echo "Enhanced shutdown script started"

# Check if we're in a preemption scenario for fast-path logic
PREEMPTION_MODE=false
if is_preemption; then
    echo "⚡ Preemption detected - using fast-path shutdown"
    PREEMPTION_MODE=true
fi

# Get instance name
INSTANCE_NAME=$(curl -s -H "Metadata-Flavor: Google" \
    "http://metadata.google.internal/computeMetadata/v1/instance/name" 2>/dev/null || echo "unknown")

echo "Instance name: $INSTANCE_NAME"
echo "Preemption mode: $PREEMPTION_MODE"

# Load runner configuration
if [ ! -f "$RUNNER_USERS_FILE" ]; then
    echo "❌ Runner users file not found: $RUNNER_USERS_FILE"
    echo "Triggering Cloud Function cleanup as primary method..."
    trigger_cloud_function_cleanup "$INSTANCE_NAME"
    exit 0
fi

echo "Loading runner configuration from: $RUNNER_USERS_FILE"
source "$RUNNER_USERS_FILE"

echo "Runner count: ${RUNNER_COUNT:-unknown}"
echo "Runner user prefix: ${RUNNER_USER_PREFIX:-unknown}"

# Get GitHub PAT
GITHUB_PAT=""

# Try to get PAT from local file first (faster during shutdown)
if [ -f "$PAT_FILE" ]; then
    echo "Reading GitHub PAT from local file..."
    GITHUB_PAT=$(cat "$PAT_FILE" 2>/dev/null || echo "")
fi

# Fallback to Secret Manager if local file failed and not in preemption mode
if [ -z "$GITHUB_PAT" ] && [ "$PREEMPTION_MODE" = false ]; then
    echo "Local PAT file not available, trying Secret Manager..."
    GITHUB_PAT=$(gcloud secrets versions access latest --secret="github-runner-token" 2>/dev/null || echo "")
fi

if [ -z "$GITHUB_PAT" ]; then
    echo "❌ Could not retrieve GitHub PAT"
    echo "Triggering Cloud Function cleanup as fallback..."
    trigger_cloud_function_cleanup "$INSTANCE_NAME"
    exit 1
fi

echo "✅ GitHub PAT obtained for runner deregistration"

# Collect runner names for Cloud Function backup
runner_names=()

# Deregister runners and stop containers
echo "=== Deregistering $RUNNER_COUNT runners from GitHub ==="

successful_deregistrations=0
failed_deregistrations=0

for i in $(seq 1 "$RUNNER_COUNT"); do
    RUNNER_USER="${RUNNER_USER_PREFIX}-${i}"
    RUNNER_NAME="${INSTANCE_NAME}-${RANDOM_SUFFIX}-${i}"
    CONTAINER_NAME="github-runner-${RUNNER_USER}"
    
    runner_names+=("$RUNNER_NAME")
    
    echo "Processing runner $i: $RUNNER_NAME ($RUNNER_USER)"
    
    # Try to remove from GitHub using remove token
    if remove_runner_from_github "$RUNNER_NAME" "$GITHUB_PAT" "$CONTAINER_NAME"; then
        ((successful_deregistrations++))
    else
        ((failed_deregistrations++))
        echo "⚠️  Will rely on Cloud Function backup for $RUNNER_NAME"
    fi
    
    # Stop and remove container (if not in preemption mode or if quick)
    if [ "$PREEMPTION_MODE" = false ] || ! timeout 10 sudo -u "$RUNNER_USER" docker stop "$CONTAINER_NAME" 2>/dev/null; then
        if [ "$PREEMPTION_MODE" = true ]; then
            echo "⚡ Skipping container cleanup due to preemption time constraints"
        else
            echo "Stopping container: $CONTAINER_NAME"
            sudo -u "$RUNNER_USER" docker stop "$CONTAINER_NAME" 2>/dev/null || true
            sudo -u "$RUNNER_USER" docker rm "$CONTAINER_NAME" 2>/dev/null || true
        fi
    fi
done

echo "=== Deregistration Summary ==="
echo "Successful: $successful_deregistrations"
echo "Failed: $failed_deregistrations"
echo "Total: $RUNNER_COUNT"

# Always trigger Cloud Function cleanup as backup, especially if there were failures
if [ $failed_deregistrations -gt 0 ] || [ "$PREEMPTION_MODE" = true ]; then
    echo "Triggering Cloud Function cleanup due to failures or preemption..."
    trigger_cloud_function_cleanup "$INSTANCE_NAME" "${runner_names[@]}"
else
    echo "All runners deregistered successfully, triggering Cloud Function for verification..."
    trigger_cloud_function_cleanup "$INSTANCE_NAME" "${runner_names[@]}"
fi

# Skip heavy cleanup operations in preemption mode
if [ "$PREEMPTION_MODE" = false ]; then
    echo "Performing final cleanup (non-preemption mode)..."
    
    # Clean up Docker resources
    echo "Cleaning up Docker resources..."
    docker system prune -f 2>/dev/null || true
    
    # Clean up runner directories
    for i in $(seq 1 "$RUNNER_COUNT"); do
        RUNNER_USER="${RUNNER_USER_PREFIX}-${i}"
        if id "$RUNNER_USER" >/dev/null 2>&1; then
            echo "Cleaning up user: $RUNNER_USER"
            rm -rf "/home/$RUNNER_USER" 2>/dev/null || true
            userdel "$RUNNER_USER" 2>/dev/null || true
        fi
    done
else
    echo "⚡ Skipping heavy cleanup operations due to preemption"
fi

# Create completion marker
echo "$(date): Enhanced shutdown completed. Success: $successful_deregistrations, Failed: $failed_deregistrations" > /var/log/shutdown-complete-enhanced.txt

echo "=== Enhanced Multi-User Docker Runner shutdown completed at $(date) ==="
echo "Cloud Function backup cleanup has been triggered for additional reliability"

exit 0
