#!/bin/bash
set -euo pipefail

# Docker-based GitHub Runner shutdown script
# This script gracefully removes Docker containers and performs cleanup

# Configuration file from startup script
RUNNER_CONFIG_DIR="/home/runner/runner-config"
RUNNER_INFO_FILE="$RUNNER_CONFIG_DIR/runner-info.txt"

# Redirect all output to syslog and a dedicated log file
exec > >(tee -a /var/log/runner-shutdown-docker.log) 2>&1
echo "=== Docker Runner shutdown starting at $(date) ==="

# Check if configuration file exists
if [ ! -f "$RUNNER_INFO_FILE" ]; then
    echo "Warning: Runner info file not found at $RUNNER_INFO_FILE" >&2
    echo "Attempting generic Docker cleanup..." >&2
    
    # Generic cleanup - stop and remove all github-runner containers
    echo "Stopping all GitHub runner containers..."
    CONTAINERS=$(docker ps -a --filter "name=github-runner" --format "{{.Names}}" 2>/dev/null || true)
    
    if [ -n "$CONTAINERS" ]; then
        echo "Found containers: $CONTAINERS"
        for container in $CONTAINERS; do
            echo "Stopping container: $container"
            docker stop "$container" 2>/dev/null || echo "⚠️  Failed to stop $container"
            echo "Removing container: $container"
            docker rm "$container" 2>/dev/null || echo "⚠️  Failed to remove $container"
        done
    else
        echo "No GitHub runner containers found"
    fi
else
    echo "Reading runner configuration from $RUNNER_INFO_FILE"
    
    # Source the configuration
    source "$RUNNER_INFO_FILE"
    
    echo "Configuration loaded:"
    echo "  Instance: $INSTANCE_NAME"
    echo "  Runner: $RUNNER_NAME" 
    echo "  Container: $CONTAINER_NAME"
    
    # Stop monitoring script if running
    echo "Stopping Docker runner monitor..."
    pkill -f "docker-runner-monitor.sh" 2>/dev/null || echo "Monitor not running"
    
    # Check if container exists and is running
    if docker ps --filter "name=$CONTAINER_NAME" --format "{{.Names}}" | grep -q "$CONTAINER_NAME"; then
        echo "Container $CONTAINER_NAME is running, stopping gracefully..."
        
        # Get GitHub PAT and generate remove token for proper runner removal
        GITHUB_PAT=$(gcloud secrets versions access latest --secret="github-runner-token" 2>/dev/null || echo "")
        
        if [ -n "$GITHUB_PAT" ] && [ -n "$REPO_OWNER" ] && [ -n "$REPO_NAME" ]; then
            echo "Generating GitHub remove token for repository $REPO_OWNER/$REPO_NAME..."
            
            # Generate remove token using GitHub API
            REMOVE_TOKEN_RESPONSE=$(curl -s -X POST \
                -H "Authorization: Bearer $GITHUB_PAT" \
                -H "Accept: application/vnd.github+json" \
                -H "User-Agent: github-runner-shutdown" \
                "https://api.github.com/repos/$REPO_OWNER/$REPO_NAME/actions/runners/remove-token" 2>/dev/null || echo "")
            
            if [ -n "$REMOVE_TOKEN_RESPONSE" ]; then
                REMOVE_TOKEN=$(echo "$REMOVE_TOKEN_RESPONSE" | jq -r '.token' 2>/dev/null || echo "")
                
                if [ -n "$REMOVE_TOKEN" ] && [ "$REMOVE_TOKEN" != "null" ]; then
                    echo "✓ Remove token generated successfully"
                    echo "Removing runner from GitHub repository..."
                    # Execute removal command inside the container with proper remove token
                    docker exec "$CONTAINER_NAME" /actions-runner/config.sh remove --token "$REMOVE_TOKEN" 2>/dev/null || echo "⚠️  Failed to remove runner from GitHub"
                else
                    echo "⚠️  Failed to parse remove token from API response"
                    echo "Response: $REMOVE_TOKEN_RESPONSE"
                fi
            else
                echo "⚠️  Failed to generate remove token from GitHub API"
            fi
        else
            echo "Warning: Could not retrieve GitHub PAT or repository info, skipping runner removal from GitHub"
            echo "  GITHUB_PAT present: $([ -n "$GITHUB_PAT" ] && echo "yes" || echo "no")"
            echo "  REPO_OWNER: ${REPO_OWNER:-"not set"}"
            echo "  REPO_NAME: ${REPO_NAME:-"not set"}"
        fi
        
        # Stop the container gracefully
        echo "Stopping container $CONTAINER_NAME..."
        docker stop "$CONTAINER_NAME" 2>/dev/null || echo "⚠️  Failed to stop container"
        
        echo "✓ Container stopped"
    elif docker ps -a --filter "name=$CONTAINER_NAME" --format "{{.Names}}" | grep -q "$CONTAINER_NAME"; then
        echo "Container $CONTAINER_NAME exists but is not running"
    else
        echo "Container $CONTAINER_NAME not found"
    fi
    
    # Remove the container
    if docker ps -a --filter "name=$CONTAINER_NAME" --format "{{.Names}}" | grep -q "$CONTAINER_NAME"; then
        echo "Removing container $CONTAINER_NAME..."
        docker rm "$CONTAINER_NAME" 2>/dev/null || echo "⚠️  Failed to remove container"
        echo "✓ Container removed"
    fi
fi

# General Docker cleanup
echo "Performing general Docker cleanup..."

# Stop all running containers (in case there are orphaned ones)
echo "Stopping all running containers..."
RUNNING_CONTAINERS=$(docker ps -q 2>/dev/null || true)
if [ -n "$RUNNING_CONTAINERS" ]; then
    docker stop $RUNNING_CONTAINERS 2>/dev/null || true
    echo "✓ Stopped running containers"
else
    echo "No running containers found"
fi

# Remove all containers
echo "Removing all containers..."
ALL_CONTAINERS=$(docker ps -aq 2>/dev/null || true)
if [ -n "$ALL_CONTAINERS" ]; then
    docker rm $ALL_CONTAINERS 2>/dev/null || true
    echo "✓ Removed all containers"
else
    echo "No containers to remove"
fi

# Clean up volumes
echo "Cleaning up Docker volumes..."
docker volume prune -f 2>/dev/null || echo "⚠️  Failed to prune volumes"
echo "✓ Docker volumes cleaned"

# Clean up networks (keep default ones)
echo "Cleaning up Docker networks..."
docker network prune -f 2>/dev/null || echo "⚠️  Failed to prune networks"
echo "✓ Docker networks cleaned"

# Clean up images (optional, removes unused images)
echo "Cleaning up unused Docker images..."
docker image prune -a -f 2>/dev/null || echo "⚠️  Failed to prune images"
echo "✓ Docker images cleaned"

# Standard runner cleanup
echo "Performing standard runner cleanup..."

# Remove configuration directory
if [ -d "$RUNNER_CONFIG_DIR" ]; then
    echo "Removing runner configuration directory..."
    rm -rf "$RUNNER_CONFIG_DIR"
    echo "✓ Configuration directory removed"
fi

# Remove monitoring script
if [ -f "/usr/local/bin/docker-runner-monitor.sh" ]; then
    echo "Removing monitoring script..."
    rm -f "/usr/local/bin/docker-runner-monitor.sh"
    echo "✓ Monitoring script removed"
fi

# Clean up log files older than 7 days
echo "Cleaning up old log files..."
find /var/log -name "*runner*" -type f -mtime +7 -delete 2>/dev/null || true
echo "✓ Old log files cleaned"

# Rust-specific cleanup
echo "Performing Rust-specific cleanup..."
# Clean Cargo caches for all users
find /home -name ".cargo" -type d 2>/dev/null | while read -r cargo_dir; do
    if [ -d "$cargo_dir/registry" ]; then
        echo "Cleaning Cargo registry cache in $cargo_dir"
        rm -rf "$cargo_dir/registry/cache"/* 2>/dev/null || true
        rm -rf "$cargo_dir/registry/src"/* 2>/dev/null || true
    fi
    if [ -d "$cargo_dir/target" ]; then
        echo "Cleaning Cargo target directory in $cargo_dir"
        rm -rf "$cargo_dir/target"/* 2>/dev/null || true
    fi
done

# Clean Rust temporary files
echo "Cleaning Rust temporary files..."
rm -rf /tmp/cargo-* 2>/dev/null || true
rm -rf /tmp/rust-* 2>/dev/null || true

echo "✓ Rust-specific cleanup completed"

# Optional: Remove Docker entirely (commented out for safety)
# echo "Removing Docker (optional)..."
# apt-get remove -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin 2>/dev/null || true
# apt-get autoremove -y 2>/dev/null || true

# Show Docker status
echo "Final Docker status:"
docker info 2>/dev/null | grep -E "(Containers|Images|Storage Driver)" || echo "Docker not accessible"

echo "=== Docker Runner shutdown completed at $(date) ==="
echo "✅ Docker runner cleanup completed successfully"