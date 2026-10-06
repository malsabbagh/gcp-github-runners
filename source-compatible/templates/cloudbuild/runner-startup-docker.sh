#!/bin/bash
set -euo pipefail

# Docker-based GitHub Runner startup script
# This script runs GitHub Actions runners in Docker containers

# Redirect all output to syslog and a dedicated log file
exec > >(tee -a /var/log/runner-startup-docker.log) 2>&1
echo "=== Docker Runner setup starting at $(date) ==="

# 1) Install prerequisites and Docker
echo "=== Installing prerequisites and Docker ==="
apt-get update
apt-get install -y curl jq

# Install Docker if not present
if ! command -v docker &> /dev/null; then
    echo "Installing Docker..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sh get-docker.sh
    rm get-docker.sh
    echo "✓ Docker installed"
else
    echo "✓ Docker already installed"
fi

# 2) Create 'runner' user and setup Docker access
if ! id -u runner &>/dev/null; then
    useradd -m -s /bin/bash runner
    usermod -aG sudo runner
    cat <<EOF >/etc/sudoers.d/runner
runner ALL=(ALL) NOPASSWD:ALL
EOF
    chmod 440 /etc/sudoers.d/runner
    echo "✓ Created runner user"
else
    echo "✓ Runner user already exists"
fi

# Add runner user to docker group
usermod -aG docker runner || true
echo "✓ Added runner user to docker group"

# Start Docker service
systemctl enable docker
systemctl start docker
echo "✓ Docker service started"

# Wait for Docker to be ready
echo "Waiting for Docker daemon to be ready..."
timeout 30 bash -c 'until docker info >/dev/null 2>&1; do sleep 1; done'
echo "✓ Docker daemon is ready"

# 3) Fetch metadata attributes
MD_URL="http://metadata.google.internal/computeMetadata/v1/instance/attributes"
CURL_OPTS=(-s -H "Metadata-Flavor: Google")

REPO_OWNER=$(curl "${CURL_OPTS[@]}" "${MD_URL}/repo-owner")
REPO_NAME=$(curl "${CURL_OPTS[@]}" "${MD_URL}/repo-name")

# Fetch configurable runner version and Docker image from metadata
RUNNER_VERSION=$(curl "${CURL_OPTS[@]}" "${MD_URL}/github-runner-version" 2>/dev/null || echo "2.325.0")
DOCKER_RUNNER_IMAGE=$(curl "${CURL_OPTS[@]}" "${MD_URL}/docker-runner-image" 2>/dev/null || echo "myoung34/github-runner:v2.325.0")

# Fail early if required metadata is missing
if [[ -z "$REPO_OWNER" || -z "$REPO_NAME" ]]; then
  echo "Error: Missing metadata attributes." >&2
  exit 1
fi

echo "Metadata loaded: repo=$REPO_OWNER/$REPO_NAME"
echo "Runner Version: $RUNNER_VERSION"
echo "Docker Image: $DOCKER_RUNNER_IMAGE"
REPO_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}"

# 4) Get GitHub PAT from Secret Manager and generate registration token
echo "=== Step 4: GitHub PAT retrieval and token generation ==="
echo "Starting GitHub PAT retrieval from Secret Manager..."

# Test gcloud access first
echo "Testing gcloud authentication..."
if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" | head -n1 > /dev/null 2>&1; then
  echo "Error: No active gcloud authentication found" >&2
  exit 1
fi

ACTIVE_ACCOUNT=$(gcloud auth list --filter=status:ACTIVE --format="value(account)" | head -n1)
echo "✓ gcloud authenticated as: $ACTIVE_ACCOUNT"

echo "Retrieving GitHub PAT from Secret Manager..."
GITHUB_PAT=$(gcloud secrets versions access latest --secret="github-runner-token" 2>&1)
SECRET_EXIT_CODE=$?

if [ $SECRET_EXIT_CODE -ne 0 ]; then
  echo "Error: Failed to retrieve GitHub PAT from Secret Manager (exit code: $SECRET_EXIT_CODE)" >&2
  exit 1
fi

if [ -z "$GITHUB_PAT" ]; then
  echo "Error: GitHub PAT is empty after retrieval from Secret Manager" >&2
  exit 1
fi

echo "✓ GitHub PAT retrieved from Secret Manager"

# Test network connectivity to GitHub API
echo "Testing connectivity to GitHub API..."
if ! curl -s --connect-timeout 10 --max-time 30 -o /dev/null https://api.github.com; then
  echo "Error: Unable to connect to GitHub API (https://api.github.com)" >&2
  exit 1
fi

echo "✓ GitHub API connectivity verified"

echo "Generating runner registration token..."
if timeout 15 curl -s --connect-timeout 3 --max-time 10 \
   -X POST \
   -H "Authorization: Bearer $GITHUB_PAT" \
   "https://api.github.com/repos/$REPO_OWNER/$REPO_NAME/actions/runners/registration-token" > /tmp/token.json 2>/dev/null; then
    
    echo "✓ Registration token request completed"
    
    # Check for error in response
    if grep -q '"message"' /tmp/token.json 2>/dev/null; then
        TOKEN_ERROR=$(grep -o '"message":"[^"]*"' /tmp/token.json | cut -d'"' -f4)
        echo "Error: Failed to generate runner registration token" >&2
        echo "GitHub API Error: $TOKEN_ERROR" >&2
        exit 1
    fi
    
    # Parse token
    RUNNER_TOKEN=$(jq -r '.token' /tmp/token.json 2>/dev/null)
    
    if [ -z "$RUNNER_TOKEN" ] || [ "$RUNNER_TOKEN" = "null" ]; then
        echo "Error: Failed to extract runner registration token from response" >&2
        echo "Response: $(cat /tmp/token.json)" >&2
        exit 1
    fi
    
    echo "✓ Runner registration token generated successfully"
else
    echo "Error: Failed to generate registration token" >&2
    exit 1
fi

# 5) Get instance name for runner naming
INSTANCE_NAME=$(curl -s -H "Metadata-Flavor: Google" \
    "http://metadata.google.internal/computeMetadata/v1/instance/name" 2>/dev/null || echo "docker-runner")

# Generate random suffix for uniqueness
RANDOM_SUFFIX=$(cat /proc/sys/kernel/random/uuid | cut -d'-' -f1)
RUNNER_NAME="${INSTANCE_NAME}-docker-${RANDOM_SUFFIX}"

echo "Runner will be named: $RUNNER_NAME"

# 6) Create runner configuration directory and files
RUNNER_CONFIG_DIR="/home/runner/runner-config"
mkdir -p "$RUNNER_CONFIG_DIR"
chown runner:runner "$RUNNER_CONFIG_DIR"

# Save configuration for shutdown script
cat > "$RUNNER_CONFIG_DIR/runner-info.txt" <<EOF
# Docker runner configuration generated at $(date)
INSTANCE_NAME="$INSTANCE_NAME"
RUNNER_NAME="$RUNNER_NAME"
RANDOM_SUFFIX="$RANDOM_SUFFIX"
RUNNER_VERSION="$RUNNER_VERSION"
DOCKER_RUNNER_IMAGE="$DOCKER_RUNNER_IMAGE"
REPO_OWNER="$REPO_OWNER"
REPO_NAME="$REPO_NAME"
REPO_URL="$REPO_URL"
CONTAINER_NAME="github-runner-${RANDOM_SUFFIX}"
EOF

# 7) Run GitHub Actions runner in Docker container
echo "=== Starting GitHub Actions runner in Docker container ==="

CONTAINER_NAME="github-runner-${RANDOM_SUFFIX}"

# Create and start the runner container
# Note: We avoid using --privileged for security reasons. If your workflows require 
# privileged access (e.g., for Docker-in-Docker), you may need to add specific capabilities
# or use alternative approaches like using a separate Docker host.
sudo -u runner docker run -d \
    --name "$CONTAINER_NAME" \
    --restart unless-stopped \
    -e REPO_URL="$REPO_URL" \
    -e RUNNER_TOKEN="$RUNNER_TOKEN" \
    -e RUNNER_NAME="$RUNNER_NAME" \
    -e RUNNER_LABELS="self-hosted,linux,x64,docker" \
    -e DOCKER_ENABLED="true" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v /home/runner/runner-config:/runner-config \
    "$DOCKER_RUNNER_IMAGE"

# Wait up to 60 seconds for the container to start
echo "Waiting for container to start..."
CONTAINER_STARTED=false
for i in {1..30}; do
    # Check if container is in 'Up' status
    if sudo -u runner docker ps --filter "name=$CONTAINER_NAME" --format '{{.Status}}' | grep -q "Up"; then
        CONTAINER_STARTED=true
        break
    fi
    sleep 2
done

if [ "$CONTAINER_STARTED" = true ]; then
    echo "✅ GitHub Actions runner container started successfully"
    echo "Container name: $CONTAINER_NAME"
    echo "Runner name: $RUNNER_NAME"
    
    # Show container logs for verification
    echo "Container startup logs:"
    sudo -u runner docker logs "$CONTAINER_NAME" 2>&1 | tail -20
else
    echo "❌ Failed to start GitHub Actions runner container in 60 seconds"
    echo "Container logs:"
    sudo -u runner docker logs "$CONTAINER_NAME" 2>&1 || true
    exit 1
fi

# 8) Create enhanced monitoring script for container health
cat > /usr/local/bin/docker-runner-monitor.sh <<'EOF'
#!/bin/bash
# Enhanced Docker runner container monitoring with health checks
set -euo pipefail

CONTAINER_NAME=$(grep CONTAINER_NAME /home/runner/runner-config/runner-info.txt | cut -d'"' -f2)
LOG_FILE="/var/log/docker-runner-monitor.log"

log_message() {
    echo "$(date '+%Y-%m-%d %H:%M:%S'): $1" | tee -a "$LOG_FILE"
}

check_container_health() {
    # Check if container exists and is running
    if ! docker ps --filter "name=$CONTAINER_NAME" --format "{{.Names}}" | grep -q "^$CONTAINER_NAME$"; then
        return 1
    fi
    
    # Check container health status if health check is configured
    local health_status
    health_status=$(docker inspect --format='{{.State.Health.Status}}' "$CONTAINER_NAME" 2>/dev/null || echo "none")
    
    if [ "$health_status" = "unhealthy" ]; then
        return 1
    fi
    
    # Additional check: verify the container can respond to basic commands
    if ! docker exec "$CONTAINER_NAME" echo "health-check" >/dev/null 2>&1; then
        return 1
    fi
    
    return 0
}

restart_container() {
    log_message "Attempting to restart container $CONTAINER_NAME..."
    
    # Try to start the existing container first
    if docker start "$CONTAINER_NAME" >/dev/null 2>&1; then
        log_message "Successfully restarted existing container"
        return 0
    fi
    
    log_message "Failed to restart existing container, checking if it needs recreation..."
    return 1
}

log_message "Starting enhanced Docker runner monitoring for container: $CONTAINER_NAME"

while true; do
    if ! check_container_health; then
        log_message "Container $CONTAINER_NAME health check failed"
        
        # Get container status for debugging
        local container_status
        container_status=$(docker ps -a --filter "name=$CONTAINER_NAME" --format "{{.Status}}" 2>/dev/null || echo "not found")
        log_message "Container status: $container_status"
        
        if ! restart_container; then
            log_message "Failed to restart container. Manual intervention may be required."
            # Log recent container logs for debugging
            log_message "Recent container logs:"
            docker logs "$CONTAINER_NAME" --tail=10 2>&1 | while read -r line; do
                log_message "  $line"
            done
        fi
    fi
    
    sleep 30  # Reduced from 60s for more responsive monitoring
done
EOF

chmod +x /usr/local/bin/docker-runner-monitor.sh

# Start monitoring in background
nohup /usr/local/bin/docker-runner-monitor.sh > /var/log/docker-runner-monitor.log 2>&1 &

echo "✓ Container monitoring started"

# Clean up temporary files
rm -f /tmp/token.json

echo "=== Docker Runner setup completed at $(date) ==="
echo "Runner container: $CONTAINER_NAME"
echo "Runner name: $RUNNER_NAME" 
echo "Configuration saved to: $RUNNER_CONFIG_DIR/runner-info.txt"