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

# Get repository info from metadata (fallback)
REPO_OWNER=$(get_metadata "repo-owner")
REPO_NAME=$(get_metadata "repo-name")

echo "Repository: $REPO_OWNER/$REPO_NAME"

# CRITICAL: Get GitHub PAT first - this is essential for deregistration
echo "=== STEP 1: Getting GitHub PAT ==="
GITHUB_PAT=""
if command -v gcloud &>/dev/null; then
    echo "Retrieving GitHub PAT from Secret Manager..."
    GITHUB_PAT=$(gcloud secrets versions access latest --secret="github-runner-token" 2>/dev/null || echo "")
    if [ -n "$GITHUB_PAT" ]; then
        echo "✅ GitHub PAT retrieved successfully"
    else
        echo "❌ Failed to get GitHub PAT"
    fi
else
    echo "❌ gcloud not available"
fi

# Set up GitHub API headers
GITHUB_HEADERS=()
if [ -n "$GITHUB_PAT" ] && [ -n "$REPO_OWNER" ] && [ -n "$REPO_NAME" ]; then
    GITHUB_HEADERS=(
        -H "Authorization: Bearer $GITHUB_PAT"
        -H "Accept: application/vnd.github+json"
        -H "User-Agent: github-runner-gce-shutdown"
    )
    echo "✅ GitHub API headers configured"
else
    echo "❌ Cannot configure GitHub API - missing PAT or repo info"
fi

# Function to delete runner from GitHub by name
delete_runner_from_github() {
    local runner_name="$1"
    
    if [ ${#GITHUB_HEADERS[@]} -eq 0 ]; then
        echo "❌ Cannot delete $runner_name - no GitHub API access"
        return 1
    fi
    
    echo "🔍 Looking up runner '$runner_name' in GitHub..."
    
    # Get runner list and find our runner
    local runners_json
    runners_json=$(curl -s "https://api.github.com/repos/$REPO_OWNER/$REPO_NAME/actions/runners?per_page=100" "${GITHUB_HEADERS[@]}" 2>/dev/null)
    
    if [ $? -ne 0 ] || [ -z "$runners_json" ]; then
        echo "❌ Failed to get runners list from GitHub"
        return 1
    fi
    
    # Extract runner ID using grep and sed (no jq dependency)
    local runner_id
    runner_id=$(echo "$runners_json" | grep -A5 -B5 "\"name\":\"$runner_name\"" | grep "\"id\":" | head -n1 | sed 's/.*"id":\s*\([0-9]*\).*/\1/')
    
    if [ -z "$runner_id" ] || [ "$runner_id" = "$runners_json" ]; then
        echo "❌ Runner '$runner_name' not found in GitHub"
        return 1
    fi
    
    echo "🎯 Found runner '$runner_name' with ID: $runner_id"
    
    # Delete the runner - with retries
    for attempt in 1 2 3; do
        echo "🗑️  Attempt $attempt: Deleting runner ID $runner_id..."
        
        local response_code
        response_code=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE \
            "https://api.github.com/repos/$REPO_OWNER/$REPO_NAME/actions/runners/$runner_id" \
            "${GITHUB_HEADERS[@]}")
        
        if [ "$response_code" = "204" ]; then
            echo "✅ Successfully deleted runner '$runner_name' from GitHub!"
            return 0
        else
            echo "⚠️  Delete attempt $attempt failed with HTTP $response_code"
            sleep 3
        fi
    done
    
    echo "❌ Failed to delete runner '$runner_name' after 3 attempts"
    return 1
}

# STEP 2: Stop containers and deregister runners
echo "=== STEP 2: Processing runners ==="

# Track success
DEREGISTERED_COUNT=0
TOTAL_RUNNERS=0

if [ -f "$RUNNER_USERS_FILE" ]; then
    echo "📄 Found runner config file: $RUNNER_USERS_FILE"
    
    # Source the config to get variables
    source "$RUNNER_USERS_FILE" 2>/dev/null || true
    
    # Get all saved runner names
    SAVED_RUNNER_NAMES=($(grep "^RUNNER_NAME_[0-9]*=" "$RUNNER_USERS_FILE" | sed 's/.*="\(.*\)"/\1/' || true))
    TOTAL_RUNNERS=${#SAVED_RUNNER_NAMES[@]}
    
    echo "📊 Found $TOTAL_RUNNERS saved runner names"
    
    # Process each saved runner name
    for runner_name in "${SAVED_RUNNER_NAMES[@]}"; do
        echo "🔄 Processing runner: $runner_name"
        
        # Try to deregister from GitHub
        if delete_runner_from_github "$runner_name"; then
            DEREGISTERED_COUNT=$((DEREGISTERED_COUNT + 1))
        fi
    done
    
    # Also try to stop containers
    echo "🐳 Stopping Docker containers..."
    CONTAINER_NAMES=($(grep "^CONTAINER_NAME_[0-9]*=" "$RUNNER_USERS_FILE" | sed 's/.*="\(.*\)"/\1/' || true))
    USER_NAMES=($(grep "^RUNNER_USER_[0-9]*=" "$RUNNER_USERS_FILE" | sed 's/.*="\(.*\)"/\1/' || true))
    
    for i in "${!CONTAINER_NAMES[@]}"; do
        container_name="${CONTAINER_NAMES[$i]}"
        user_name="${USER_NAMES[$i]:-}"
        
        if [ -n "$container_name" ] && [ -n "$user_name" ]; then
            echo "🛑 Stopping container '$container_name' for user '$user_name'"
            if id -u "$user_name" &>/dev/null; then
                sudo -u "$user_name" docker stop "$container_name" 2>/dev/null || echo "⚠️  Failed to stop $container_name"
                sudo -u "$user_name" docker rm "$container_name" 2>/dev/null || echo "⚠️  Failed to remove $container_name"
            fi
        fi
    done
    
else
    echo "❌ No runner config file found - will try generic cleanup"
    
    # Fallback: try to find and deregister any runners with our instance name
    INSTANCE_NAME=$(curl -sf -H "Metadata-Flavor: Google" "http://metadata.google.internal/computeMetadata/v1/instance/name" 2>/dev/null || echo "")
    
    if [ -n "$INSTANCE_NAME" ] && [ ${#GITHUB_HEADERS[@]} -gt 0 ]; then
        echo "🔍 Looking for runners containing instance name: $INSTANCE_NAME"
        
        # Get all runners and filter by instance name
        local runners_json
        runners_json=$(curl -s "https://api.github.com/repos/$REPO_OWNER/$REPO_NAME/actions/runners?per_page=100" "${GITHUB_HEADERS[@]}" 2>/dev/null)
        
        if [ $? -eq 0 ] && [ -n "$runners_json" ]; then
            # Extract runner names containing our instance name
            local matching_runners
            matching_runners=($(echo "$runners_json" | grep "\"name\":" | sed 's/.*"name":"\([^"]*\)".*/\1/' | grep "$INSTANCE_NAME" || true))
            
            TOTAL_RUNNERS=${#matching_runners[@]}
            echo "📊 Found $TOTAL_RUNNERS matching runners"
            
            for runner_name in "${matching_runners[@]}"; do
                echo "🔄 Processing matched runner: $runner_name"
                if delete_runner_from_github "$runner_name"; then
                    DEREGISTERED_COUNT=$((DEREGISTERED_COUNT + 1))
                fi
            done
        fi
    fi
fi

# STEP 3: Cleanup users and containers
echo "=== STEP 3: User cleanup ==="

# Find and clean up runner users
RUNNER_USERS=($(getent passwd | grep "^runner-" | cut -d: -f1 || true))
for user in "${RUNNER_USERS[@]}"; do
    echo "🧹 Cleaning up user: $user"
    
    # Stop any remaining containers
    if id -u "$user" &>/dev/null; then
        CONTAINERS=$(sudo -u "$user" docker ps -a --filter "name=github-runner" --format "{{.Names}}" 2>/dev/null || true)
        for container in $CONTAINERS; do
            echo "🛑 Stopping remaining container: $container"
            sudo -u "$user" docker stop "$container" 2>/dev/null || true
            sudo -u "$user" docker rm "$container" 2>/dev/null || true
        done
        
        # Remove user
        userdel -r "$user" 2>/dev/null || echo "⚠️  Failed to remove user $user"
        rm -f "/etc/sudoers.d/$user" 2>/dev/null || true
    fi
done

# STEP 4: Final status
echo "=== STEP 4: Final status ==="
echo "📊 DEREGISTRATION SUMMARY:"
echo "   Total runners found: $TOTAL_RUNNERS"
echo "   Successfully deregistered: $DEREGISTERED_COUNT"
echo "   Failed: $((TOTAL_RUNNERS - DEREGISTERED_COUNT))"

# Create completion marker
echo "$(date): Shutdown completed. Deregistered $DEREGISTERED_COUNT/$TOTAL_RUNNERS runners" > /var/log/runner-shutdown.done

# Cleanup files
rm -f "$RUNNER_USERS_FILE" 2>/dev/null || true
rm -f /usr/local/bin/multi-docker-runner-monitor.sh 2>/dev/null || true

echo "=== Multi-User Docker Runner shutdown completed at $(date) ==="

if [ $DEREGISTERED_COUNT -eq $TOTAL_RUNNERS ] && [ $TOTAL_RUNNERS -gt 0 ]; then
    echo "✅ SUCCESS: All runners deregistered successfully"
    exit 0
else
    echo "⚠️  WARNING: Some runners may not have been deregistered"
    exit 1
fi
