#!/bin/bash
set -euo pipefail

# Fence startup and shutdown retries so teardown cannot race new registrations.
exec 9>/var/run/runner-lifecycle.lock
flock -w 30 9 || exit 1
if [ -f /var/log/runner-draining ] || [ -f /var/log/runner-users.txt ]; then
    echo "Existing lifecycle state requires reconciliation; preserving runner identities." >&2
    exit 1
fi

# Multi-user GitHub Runner startup script
# This script can create multiple runners under different users

# Redirect all output to syslog and a dedicated log file
exec > >(tee -a /var/log/runner-startup-multi.log) 2>&1
echo "=== Multi-Runner setup starting at $(date) ==="

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
  DEFAULT_RUNNER_COUNT="8"
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

# 1) Install prerequisites
echo "=== Installing prerequisites ==="

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

# 2) Fetch metadata attributes  
REPO_OWNER=$(curl "${CURL_OPTS[@]}" "${MD_URL}/repo-owner" 2>/dev/null || echo "")
REPO_NAME=$(curl "${CURL_OPTS[@]}" "${MD_URL}/repo-name" 2>/dev/null || echo "")

# Fetch configurable runner version and checksum from metadata
RUNNER_VERSION=$(curl "${CURL_OPTS[@]}" "${MD_URL}/github-runner-version" 2>/dev/null)
if [[ -z "$RUNNER_VERSION" || "$RUNNER_VERSION" == \<* ]]; then
  RUNNER_VERSION="2.325.0"
fi
RUNNER_SHA256=$(curl "${CURL_OPTS[@]}" "${MD_URL}/github-runner-sha256" 2>/dev/null)
if [[ -z "$RUNNER_SHA256" || "$RUNNER_SHA256" == \<* ]]; then
  RUNNER_SHA256="5020da7139d85c776059f351e0de8fdec753affc9c558e892472d43ebeb518f4"
fi

if [[ -z "$REPO_OWNER" || -z "$REPO_NAME" ]]; then
  echo "Error: Missing metadata attributes." >&2
  exit 1
fi

echo "Repository: $REPO_OWNER/$REPO_NAME"
echo "Runner Version: $RUNNER_VERSION"
REPO_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}"

# 3) Get GitHub PAT from Secret Manager and generate registration token
echo "=== Step 3: GitHub PAT retrieval and token generation ==="
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

# 4) Save runner configuration for shutdown script
cat > "$RUNNER_USERS_FILE" <<EOF
# Multi-runner configuration generated at $(date)
INSTANCE_NAME="$INSTANCE_NAME"
RUNNER_COUNT="$RUNNER_COUNT"
RANDOM_SUFFIX="$RANDOM_SUFFIX" 
RUNNER_USER_PREFIX="$RUNNER_USER_PREFIX"
RUNNER_VERSION="$RUNNER_VERSION"
REPO_OWNER="$REPO_OWNER"
REPO_NAME="$REPO_NAME"
EOF

# 5) Create and configure multiple runners
echo "=== Creating $RUNNER_COUNT runners ==="
ARCHIVE="actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"

for i in $(seq 1 "$RUNNER_COUNT"); do
    RUNNER_USER="${RUNNER_USER_PREFIX}-${i}"
    RUNNER_NAME="${INSTANCE_NAME}-runner-${i}"
    
    echo "RUNNER_USER_$i=\"$RUNNER_USER\"" >> "$RUNNER_USERS_FILE"
    echo "RUNNER_NAME_$i=\"$RUNNER_NAME\"" >> "$RUNNER_USERS_FILE"
    
    echo "Creating runner $i/$RUNNER_COUNT - User: $RUNNER_USER, Name: $RUNNER_NAME"
    
    # Create user and grant passwordless sudo
    if ! id -u "$RUNNER_USER" &>/dev/null; then
        useradd -m -s /bin/bash "$RUNNER_USER"
        usermod -aG sudo "$RUNNER_USER"
        cat <<EOF >/etc/sudoers.d/"$RUNNER_USER"
$RUNNER_USER ALL=(ALL) NOPASSWD:ALL
EOF
        chmod 440 /etc/sudoers.d/"$RUNNER_USER"
        echo "✓ Created user: $RUNNER_USER"
    else
        echo "✓ User already exists: $RUNNER_USER"
    fi
    
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
    
    # Download, verify, extract, and install dependencies as specific runner user
    sudo -i -u "$RUNNER_USER" bash <<EOF
set -euo pipefail
cd "\$HOME"
mkdir -p actions-runner && cd actions-runner

echo "Downloading GitHub Actions runner v${RUNNER_VERSION} for ${RUNNER_USER}"
curl -L -o "${ARCHIVE}" \
  "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${ARCHIVE}"

echo "Verifying checksum for ${RUNNER_USER}"
echo "${RUNNER_SHA256}  ${ARCHIVE}" | sha256sum -c -

echo "Extracting package for ${RUNNER_USER}"
tar xzf "${ARCHIVE}"

echo "Installing OS dependencies for ${RUNNER_USER}"
sudo ./bin/installdependencies.sh
EOF

    # Configure runner as specific user
    sudo -u "$RUNNER_USER" bash <<EOF
set -euo pipefail
cd "\$HOME/actions-runner"

echo "Configuring GitHub Actions runner for ${RUNNER_USER}..."
./config.sh --unattended \
  --url "${REPO_URL}" \
  --token "${RUNNER_TOKEN}" \
  --name "${RUNNER_NAME}" \
  --labels "self-hosted,linux,x64,multi-user,runner-${i}"
EOF

    # Save the registered numeric identity before service installation can fail.
    RUNNER_ID=$(jq -er '.agentId | select(type == "number" and . > 0)' "/home/${RUNNER_USER}/actions-runner/.runner")
    echo "RUNNER_ID_$i=\"$RUNNER_ID\"" >> "$RUNNER_USERS_FILE"

    # Install & start service for this runner
    cd "/home/${RUNNER_USER}/actions-runner"
    
    echo "Installing self-hosted runner service for ${RUNNER_USER}..."
    sudo ./svc.sh install "$RUNNER_USER"
    
    echo "Starting self-hosted runner service for ${RUNNER_USER}..."
    sudo ./svc.sh start
    
    echo "✓ Runner $i/$RUNNER_COUNT ($RUNNER_USER) configured and started"
    
    # Clean up temporary token file
    rm -f /tmp/token_${i}.json
done

echo "=== Multi-Runner setup completed at $(date) ==="
echo "Created $RUNNER_COUNT runners with prefix: $RUNNER_USER_PREFIX"
echo "Configuration saved to: $RUNNER_USERS_FILE"