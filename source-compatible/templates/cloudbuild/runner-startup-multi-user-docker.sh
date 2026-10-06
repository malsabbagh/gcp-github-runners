#!/bin/bash
set -euo pipefail

# Fence startup and shutdown retries so teardown cannot race new registrations.
exec 9>/var/run/runner-lifecycle.lock
flock -w 30 9 || exit 1
if [ -f /var/log/runner-draining ] || [ -f /var/log/runner-users.txt ]; then
    echo "Existing lifecycle state requires reconciliation; preserving runner identities." >&2
    exit 1
fi

# Multi-user Docker-based GitHub Runner startup script
# This script creates multiple users, each running their own GitHub runner in Docker containers
# This provides complete isolation between runners

# Redirect all output to syslog and a dedicated log file
exec > >(tee -a /var/log/runner-startup-multi-docker.log) 2>&1
echo "=== Multi-User Docker Runner setup starting at $(date) ==="

# Configuration - read from metadata or use defaults
MD_URL="http://metadata.google.internal/computeMetadata/v1/instance/attributes"
CURL_OPTS=(-s -H "Metadata-Flavor: Google")

# Fetch defaults from metadata first
DEFAULT_INSTANCE_NAME=$(curl "${CURL_OPTS[@]}" "${MD_URL}/default-instance-name" 2>/dev/null)
if [[ -z "$DEFAULT_INSTANCE_NAME" || "$DEFAULT_INSTANCE_NAME" == \<* ]]; then
  DEFAULT_INSTANCE_NAME="github-runner"
fi
DEFAULT_RUNNER_COUNT=$(curl "${CURL_OPTS[@]}" "${MD_URL}/default-runner-count" 2>/dev/null)
if [[ -z "$DEFAULT_RUNNER_COUNT" || "$DEFAULT_RUNNER_COUNT" == \<* ]]; then
  DEFAULT_RUNNER_COUNT="4"
fi

# Now fetch actual values with defaults as fallback
RUNNER_COUNT=$(curl "${CURL_OPTS[@]}" "${MD_URL}/runner-count" 2>/dev/null)
if [[ -z "$RUNNER_COUNT" || "$RUNNER_COUNT" == \<* ]]; then
  RUNNER_COUNT="$DEFAULT_RUNNER_COUNT"
fi
INSTANCE_NAME=$(curl -s -H "Metadata-Flavor: Google" \
    "http://metadata.google.internal/computeMetadata/v1/instance/name" 2>/dev/null)
if [[ -z "$INSTANCE_NAME" || "$INSTANCE_NAME" == \<* ]]; then
  INSTANCE_NAME="$DEFAULT_INSTANCE_NAME"
fi

# Generate random prefix to avoid conflicts between different VM instances
RANDOM_SUFFIX=$(cat /proc/sys/kernel/random/uuid | cut -d'-' -f1)
RUNNER_USER_PREFIX="runner-${RANDOM_SUFFIX}"

# File to store runner user information for shutdown script
RUNNER_USERS_FILE="/var/log/runner-users.txt"

echo "=== Configuration ==="
echo "Runner count: $RUNNER_COUNT"
echo "Instance name: $INSTANCE_NAME"
echo "Runner user prefix: $RUNNER_USER_PREFIX"
echo "Random suffix: $RANDOM_SUFFIX"

# Function to register runner in Firestore for VM deletion tracking
register_runner_in_firestore() {
    local runner_name="$1"
    local instance_name="$2"
    local runner_user="$3"
    local container_name="$4"
    local runner_number="$5"
    
    echo "Registering runner $runner_name in Firestore..."
    
    # Get project ID
    local project_id
    project_id=$(curl -s -H "Metadata-Flavor: Google" \
        "http://metadata.google.internal/computeMetadata/v1/project/project-id" 2>/dev/null)
    
    if [ -z "$project_id" ]; then
        echo "Warning: Could not get project ID for Firestore registration"
        return 1
    fi
    
    # Create Firestore document data
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    
    # Use gcloud to add document to Firestore
    local firestore_data
    firestore_data=$(cat <<EOF
{
  "runnerName": "$runner_name",
  "instanceName": "$instance_name",
  "runnerUser": "$runner_user",
  "containerName": "$container_name",
  "runnerNumber": $runner_number,
  "projectId": "$project_id",
  "registeredAt": "$timestamp",
  "status": "active",
  "repoOwner": "$REPO_OWNER",
  "repoName": "$REPO_NAME"
}
EOF
)
    
    # Try to create the Firestore document
    if gcloud firestore documents create \
        --collection="github-runners" \
        --document-id="$runner_name" \
        --data="$firestore_data" 2>/dev/null; then
        echo "✅ Runner $runner_name registered in Firestore"
    else
        echo "⚠️  Warning: Failed to register runner $runner_name in Firestore (continuing anyway)"
    fi
}

# 1) Install prerequisites and Docker
echo "=== Installing prerequisites and Docker ==="

wait_for_apt_lock() {
  local lock_files=(
    /var/lib/apt/lists/lock
    /var/lib/dpkg/lock
    /var/lib/dpkg/lock-frontend
    /var/cache/apt/archives/lock
  )
  local max_wait=300  # Maximum wait time: 5 minutes
  local wait_time=0
  local sleep_interval=2
  
  echo "Checking for apt/dpkg locks..."
  
  while [ $wait_time -lt $max_wait ]; do
    local locked=0
    
    # Check if any apt/dpkg processes are running
    if pgrep -x "apt|apt-get|dpkg|aptitude|synaptic|unattended-upgrade" >/dev/null 2>&1; then
      locked=1
      echo "Waiting for apt/dpkg processes to finish... (${wait_time}s/${max_wait}s)"
    else
      # Check lock files
      for lock_file in "${lock_files[@]}"; do
        if [ -f "$lock_file" ] && fuser "$lock_file" >/dev/null 2>&1; then
          locked=1
          echo "Waiting for lock file $lock_file... (${wait_time}s/${max_wait}s)"
          break
        fi
      done
    fi
    
    if [ $locked -eq 0 ]; then
      echo "✓ All apt/dpkg locks are clear"
      return 0
    fi
    
    sleep $sleep_interval
    wait_time=$((wait_time + sleep_interval))
    
    # Increase sleep interval gradually (max 10 seconds)
    if [ $sleep_interval -lt 10 ]; then
      sleep_interval=$((sleep_interval + 1))
    fi
  done
  
  echo "Warning: Timed out waiting for apt/dpkg locks after ${max_wait}s" >&2
  echo "Attempting to continue anyway..." >&2
  return 1
}

wait_for_apt_lock
apt-get update
wait_for_apt_lock
apt-get install -y curl jq

# Install Google Cloud SDK (required for Secret Manager access and Artifact Registry auth)
if ! command -v gcloud &> /dev/null; then
  echo "Installing Google Cloud SDK..."
  wait_for_apt_lock
  apt-get install -y apt-transport-https ca-certificates gnupg
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /etc/apt/keyrings/cloud.google.gpg
  echo "deb [signed-by=/etc/apt/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" > /etc/apt/sources.list.d/google-cloud-sdk.list
  wait_for_apt_lock
  apt-get update
  wait_for_apt_lock
  apt-get install -y google-cloud-cli
  echo "✓ Google Cloud SDK installed"
else
  echo "✓ Google Cloud SDK already installed"
fi

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

# Start Docker service
systemctl enable docker
systemctl start docker
echo "✓ Docker service started"

# Wait for Docker to be ready
echo "Waiting for Docker daemon to be ready..."
timeout 30 bash -c 'until docker info >/dev/null 2>&1; do sleep 1; done'
echo "✓ Docker daemon is ready"

# Authenticate Docker to GCP Artifact Registry
if command -v gcloud &> /dev/null; then
  echo "Configuring Docker authentication for Artifact Registry..."
  gcloud auth configure-docker us-central1-docker.pkg.dev -q
  echo "✓ Docker authentication configured for Artifact Registry"
else
  echo "Warning: gcloud not found, cannot configure Docker authentication for Artifact Registry" >&2
fi

# 2) Fetch metadata attributes  
REPO_OWNER=$(curl "${CURL_OPTS[@]}" "${MD_URL}/repo-owner" 2>/dev/null || echo "")
REPO_NAME=$(curl "${CURL_OPTS[@]}" "${MD_URL}/repo-name" 2>/dev/null || echo "")

# Fetch configurable runner version and Docker image from metadata
RUNNER_VERSION=$(curl "${CURL_OPTS[@]}" "${MD_URL}/github-runner-version" 2>/dev/null)
if [[ -z "$RUNNER_VERSION" || "$RUNNER_VERSION" == \<* ]]; then
  RUNNER_VERSION="2.325.0"
fi

# Get docker-runner-image from metadata if set
DOCKER_RUNNER_IMAGE=$(curl "${CURL_OPTS[@]}" "${MD_URL}/docker-runner-image" 2>/dev/null)

# If not set, try to get project_id and construct Artifact Registry image path
if [[ -z "$DOCKER_RUNNER_IMAGE" || "$DOCKER_RUNNER_IMAGE" == \<* ]]; then
  # Try to get project_id from metadata, gcloud, or env
  PROJECT_ID=$(curl -s -H "Metadata-Flavor: Google" "http://metadata.google.internal/computeMetadata/v1/project/project-id" 2>/dev/null)
  if [[ -z "$PROJECT_ID" || "$PROJECT_ID" == \<* ]]; then
    PROJECT_ID=$(gcloud config get-value project 2>/dev/null)
  fi
  if [[ -z "$PROJECT_ID" ]]; then
    PROJECT_ID="${PROJECT_ID:-$ENV_PROJECT_ID}"
  fi
  if [[ -z "$PROJECT_ID" ]]; then
    echo "Error: PROJECT_ID is not set and could not be retrieved from metadata or gcloud." >&2
    exit 1
  fi
  DOCKER_RUNNER_IMAGE="us-central1-docker.pkg.dev/${PROJECT_ID}/github-runner-images/github-runner-rust:stable"
fi

if [[ -z "$REPO_OWNER" || -z "$REPO_NAME" ]]; then
  echo "Error: Missing metadata attributes." >&2
  exit 1
fi

echo "Repository: $REPO_OWNER/$REPO_NAME"
echo "Runner Version: $RUNNER_VERSION"
echo "Docker Image: $DOCKER_RUNNER_IMAGE"
REPO_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}"

# 3) Get GitHub PAT from Secret Manager and validate access
echo "=== Step 3: GitHub PAT retrieval and token generation ==="
echo "Starting GitHub PAT retrieval from Secret Manager..."

# Remove fragile 'gcloud auth list' check. On GCE, Application Default Credentials are used even if no active account is listed.
# We'll attempt to access Secret Manager directly and fail gracefully if permissions are missing.

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

                # CRITICAL: Store GitHub PAT for shutdown script access
                # During shutdown, Secret Manager access may fail, so we store the PAT locally
                echo "Storing GitHub PAT for shutdown script..."
                echo "$GITHUB_PAT" > /var/log/github-pat.txt
                chmod 600 /var/log/github-pat.txt
                echo "✓ GitHub PAT stored locally for shutdown script"

                # Test network connectivity to GitHub API
echo "Testing connectivity to GitHub API..."
if ! curl -s --connect-timeout 10 --max-time 30 -o /dev/null https://api.github.com; then
  echo "Error: Unable to connect to GitHub API (https://api.github.com)" >&2
  exit 1
fi

echo "✓ GitHub API connectivity verified"

# 4) Save runner configuration for shutdown script
cat > "$RUNNER_USERS_FILE" <<EOF
# Multi-user Docker runner configuration generated at $(date)
INSTANCE_NAME="$INSTANCE_NAME"
RUNNER_COUNT="$RUNNER_COUNT"
RANDOM_SUFFIX="$RANDOM_SUFFIX" 
RUNNER_USER_PREFIX="$RUNNER_USER_PREFIX"
RUNNER_VERSION="$RUNNER_VERSION"
DOCKER_RUNNER_IMAGE="$DOCKER_RUNNER_IMAGE"
REPO_OWNER="$REPO_OWNER"
REPO_NAME="$REPO_NAME"
REPO_URL="$REPO_URL"
EOF

# 5) Create and configure multiple users with Docker runners
echo "=== Creating $RUNNER_COUNT Docker runners ==="

echo "# To use a custom image for a specific runner, set instance metadata key 'docker-runner-image-<i>' (e.g., docker-runner-image-1)"

echo "Global Docker image: $DOCKER_RUNNER_IMAGE"

for i in $(seq 1 "$RUNNER_COUNT"); do
    RUNNER_USER="${RUNNER_USER_PREFIX}-${i}"
    RUNNER_NAME="${INSTANCE_NAME}-runner-${i}"
    CONTAINER_NAME="github-runner-${RANDOM_SUFFIX}-${i}"
    
    # Allow per-runner Docker image override via metadata
    PER_RUNNER_IMAGE=$(curl "${CURL_OPTS[@]}" "${MD_URL}/docker-runner-image-${i}" 2>/dev/null)
    if [[ -n "$PER_RUNNER_IMAGE" && "$PER_RUNNER_IMAGE" != \<* ]]; then
      IMAGE_TO_USE="$PER_RUNNER_IMAGE"
    else
      IMAGE_TO_USE="$DOCKER_RUNNER_IMAGE"
    fi
    
    echo "RUNNER_USER_$i=\"$RUNNER_USER\"" >> "$RUNNER_USERS_FILE"
    echo "CONTAINER_NAME_$i=\"$CONTAINER_NAME\"" >> "$RUNNER_USERS_FILE"
    echo "DOCKER_IMAGE_$i=\"$IMAGE_TO_USE\"" >> "$RUNNER_USERS_FILE"
    # Persist runner name for reliable API cleanup during shutdown even if container is gone
    echo "RUNNER_NAME_$i=\"$RUNNER_NAME\"" >> "$RUNNER_USERS_FILE"
    
    echo "Creating Docker runner $i/$RUNNER_COUNT - User: $RUNNER_USER, Name: $RUNNER_NAME, Container: $CONTAINER_NAME, Image: $IMAGE_TO_USE"
    
    # Create user and grant passwordless sudo
    if ! id -u "$RUNNER_USER" &>/dev/null; then
        useradd -m -s /bin/bash "$RUNNER_USER"
        usermod -aG sudo "$RUNNER_USER"
        usermod -aG docker "$RUNNER_USER"
        cat <<EOF >/etc/sudoers.d/"$RUNNER_USER"
$RUNNER_USER ALL=(ALL) NOPASSWD:ALL
EOF
        chmod 440 /etc/sudoers.d/"$RUNNER_USER"
        echo "✓ Created user: $RUNNER_USER with Docker access"
    else
        echo "✓ User already exists: $RUNNER_USER"
        # Ensure user is in docker group
        usermod -aG docker "$RUNNER_USER" || true
    fi

    # Ensure Docker credential config is available for the runner user
    if [ -f /root/.docker/config.json ]; then
        mkdir -p "/home/${RUNNER_USER}/.docker"
        cp /root/.docker/config.json "/home/${RUNNER_USER}/.docker/config.json"
        chown -R "$RUNNER_USER:$RUNNER_USER" "/home/${RUNNER_USER}/.docker"
        echo "✓ Copied Docker config for $RUNNER_USER"
    fi
    
    # Create runner configuration directory for this user
    RUNNER_CONFIG_DIR="/home/${RUNNER_USER}/runner-config"
    mkdir -p "$RUNNER_CONFIG_DIR"
    chown "$RUNNER_USER:$RUNNER_USER" "$RUNNER_CONFIG_DIR"
    
    # Generate registration token for this runner
    echo "Generating registration token for runner $i..."
    if timeout 15 curl -s --connect-timeout 3 --max-time 10 \
       -X POST \
       -H "Authorization: Bearer $GITHUB_PAT" \
       "https://api.github.com/repos/$REPO_OWNER/$REPO_NAME/actions/runners/registration-token" > /tmp/token_${i}.json 2>/dev/null; then
        
        # Check for error in response
        if grep -q '"message"' /tmp/token_${i}.json 2>/dev/null; then
            TOKEN_ERROR=$(grep -o '"message":"[^"]*"' /tmp/token_${i}.json | cut -d'"' -f4)
            echo "Error: Failed to generate runner registration token for runner $i" >&2
            echo "GitHub API Error: $TOKEN_ERROR" >&2
            exit 1
        fi
        
        # Parse token
        RUNNER_TOKEN=$(jq -r '.token' /tmp/token_${i}.json 2>/dev/null)
        
        if [ -z "$RUNNER_TOKEN" ] || [ "$RUNNER_TOKEN" = "null" ]; then
            echo "Error: Failed to extract runner registration token from response for runner $i" >&2
            exit 1
        fi
        
        echo "✓ Runner registration token generated for runner $i"
    else
        echo "Error: Failed to generate registration token for runner $i" >&2
        exit 1
    fi
    
    # Save configuration for this runner
    cat > "$RUNNER_CONFIG_DIR/runner-info.txt" <<EOF
# Docker runner configuration for user $RUNNER_USER generated at $(date)
INSTANCE_NAME="$INSTANCE_NAME"
RUNNER_NAME="$RUNNER_NAME"
RANDOM_SUFFIX="$RANDOM_SUFFIX"
RUNNER_USER="$RUNNER_USER"
RUNNER_NUMBER="$i"
RUNNER_VERSION="$RUNNER_VERSION"
DOCKER_RUNNER_IMAGE="$DOCKER_RUNNER_IMAGE"
REPO_OWNER="$REPO_OWNER"
REPO_NAME="$REPO_NAME"
REPO_URL="$REPO_URL"
CONTAINER_NAME="$CONTAINER_NAME"
EOF
    chown "$RUNNER_USER:$RUNNER_USER" "$RUNNER_CONFIG_DIR/runner-info.txt"
    
    # Run GitHub Actions runner in Docker container as the specific user
    echo "Starting GitHub Actions runner container for $RUNNER_USER..."
    
    # Get the host docker group ID to ensure proper permissions
    DOCKER_GID=$(getent group docker | cut -d: -f3)
    
    # Create and start the runner container as the specific user
    sudo -u "$RUNNER_USER" docker run -d \
        --name "$CONTAINER_NAME" \
        --restart unless-stopped \
        --group-add "$DOCKER_GID" \
        -e GITHUB_PAT="$GITHUB_PAT" \
        -e REPO_URL="$REPO_URL" \
        -e RUNNER_NAME="$RUNNER_NAME" \
        -e RUNNER_LABELS="self-hosted,linux,x64,docker,multi-user,runner-${i}" \
        -e DOCKER_ENABLED="true" \
        -v /var/run/docker.sock:/var/run/docker.sock \
        -v "$RUNNER_CONFIG_DIR:/runner-config" \
        "$IMAGE_TO_USE"
    
    # Wait up to 60 seconds for the container to start
    echo "Waiting for container to start..."
    CONTAINER_STARTED=false
    for j in {1..30}; do
        # Check if container is in 'Up' status
        if sudo -u "$RUNNER_USER" docker ps --filter "name=$CONTAINER_NAME" --format '{{.Status}}' | grep -q "Up"; then
            CONTAINER_STARTED=true
            break
        fi
        sleep 2
    done
    
    if [ "$CONTAINER_STARTED" = true ]; then
        echo "✅ GitHub Actions runner container started successfully for $RUNNER_USER"
        echo "Container name: $CONTAINER_NAME"
        echo "Runner name: $RUNNER_NAME"
        
        # Show container logs for verification
        echo "Container startup logs:"
        sudo -u "$RUNNER_USER" docker logs "$CONTAINER_NAME" 2>&1 | tail -10
        
        # Register runner in Firestore for VM deletion tracking
        echo "Registering runner in Firestore for deletion tracking..."
        register_runner_in_firestore "$RUNNER_NAME" "$INSTANCE_NAME" "$RUNNER_USER" "$CONTAINER_NAME" "$i"
    else
        echo "❌ Failed to start GitHub Actions runner container for $RUNNER_USER in 60 seconds"
        echo "Container logs:"
        sudo -u "$RUNNER_USER" docker logs "$CONTAINER_NAME" 2>&1 || true
        exit 1
    fi
    
    echo "✓ Runner $i/$RUNNER_COUNT ($RUNNER_USER) configured and started"
    
    # Clean up temporary token file
    rm -f /tmp/token_${i}.json
done

# 6) Create enhanced monitoring script for all containers
cat > /usr/local/bin/multi-docker-runner-monitor.sh <<'EOF'
#!/bin/bash
# Enhanced multi-user Docker runner container monitoring with health checks
set -euo pipefail

RUNNER_USERS_FILE="/var/log/runner-users.txt"
LOG_FILE="/var/log/multi-docker-runner-monitor.log"

log_message() {
    echo "$(date '+%Y-%m-%d %H:%M:%S'): $1" | tee -a "$LOG_FILE"
}

check_container_health() {
    local container_name="$1"
    local user="$2"
    
    # Check if container exists and is running
    if ! sudo -u "$user" docker ps --filter "name=$container_name" --format "{{.Names}}" | grep -q "^$container_name$"; then
        return 1
    fi
    
    # Check container health status if health check is configured
    local health_status
    health_status=$(sudo -u "$user" docker inspect --format='{{.State.Health.Status}}' "$container_name" 2>/dev/null || echo "none")
    
    if [ "$health_status" = "unhealthy" ]; then
        return 1
    fi
    
    # Additional check: verify the container can respond to basic commands
    if ! sudo -u "$user" docker exec "$container_name" echo "health-check" >/dev/null 2>&1; then
        return 1
    fi
    
    return 0
}

restart_container() {
    local container_name="$1"
    local user="$2"
    
    # Serialize restart with teardown so a monitor cannot recreate a removed runner.
    exec 8>/var/run/runner-lifecycle.lock
    flock -w 1 8 || return 1
    if [ -f /var/log/runner-draining ]; then flock -u 8; return 1; fi
    log_message "Attempting to restart container $container_name for user $user..."
    
    # Starting an exited container is safe. Do not force-restart a running
    # unhealthy container: it may still own a job and needs manual reconciliation.
    local state
    state=$(sudo -u "$user" docker inspect --format='{{.State.Status}}' "$container_name" 2>/dev/null) || { flock -u 8; return 1; }
    case "$state" in exited|created) ;; *) flock -u 8; return 1 ;; esac
    if sudo -u "$user" docker start "$container_name" >/dev/null 2>&1; then
        log_message "Successfully restarted existing container $container_name"
        flock -u 8
        return 0
    fi
    
    log_message "Failed to restart existing container $container_name, manual intervention may be required"
    flock -u 8
    return 1
}

if [ ! -f "$RUNNER_USERS_FILE" ]; then
    log_message "Error: Runner users file not found at $RUNNER_USERS_FILE"
    exit 1
fi

# Extract container information
users=()
containers=()
while IFS= read -r line; do
    if [[ $line =~ ^RUNNER_USER_([0-9]+)=\"(.*)\"$ ]]; then
        user_num="${BASH_REMATCH[1]}"
        user_name="${BASH_REMATCH[2]}"
        
        # Find corresponding container name
        container_line=$(grep "^CONTAINER_NAME_${user_num}=" "$RUNNER_USERS_FILE" || echo "")
        if [[ $container_line =~ ^CONTAINER_NAME_[0-9]+=\"(.*)\"$ ]]; then
            container_name="${BASH_REMATCH[1]}"
            users+=("$user_name")
            containers+=("$container_name")
        fi
    fi
done < "$RUNNER_USERS_FILE"

log_message "Starting enhanced multi-user Docker runner monitoring for ${#users[@]} runners"

while true; do
    [ ! -f /var/log/runner-draining ] || exit 0
    for i in "${!users[@]}"; do
        user="${users[$i]}"
        container="${containers[$i]}"
        
        if ! check_container_health "$container" "$user"; then
            log_message "Container $container health check failed for user $user"
            
            # Get container status for debugging
            container_status=""
            container_status=$(sudo -u "$user" docker ps -a --filter "name=$container" --format "{{.Status}}" 2>/dev/null || echo "not found")
            log_message "Container status: $container_status"
            
            if ! restart_container "$container" "$user"; then
                log_message "Failed to restart container $container for user $user. Manual intervention may be required."
                # Log recent container logs for debugging
                log_message "Recent container logs for $container:"
                sudo -u "$user" docker logs "$container" --tail=10 2>&1 | while read -r line; do
                    log_message "  $line"
                done || true
            fi
        fi
    done
    
    sleep 30  # Check every 30 seconds for responsive monitoring
done
EOF

chmod +x /usr/local/bin/multi-docker-runner-monitor.sh

# Start monitoring in background
nohup /usr/local/bin/multi-docker-runner-monitor.sh > /var/log/multi-docker-runner-monitor.log 2>&1 9>&- &

echo "✓ Multi-container monitoring started"

echo "=== Multi-User Docker Runner setup completed at $(date) ==="
echo "Created $RUNNER_COUNT runners with prefix: $RUNNER_USER_PREFIX"
echo "Configuration saved to: $RUNNER_USERS_FILE"
echo "Each runner runs in its own isolated Docker container under separate user accounts"
