#!/bin/bash
set -euo pipefail

# Redirect all output to syslog and a dedicated log file
exec > >(tee -a /var/log/runner-startup.log) 2>&1
echo "=== Runner setup starting at $(date) ==="

# 1) Install prerequisites
apt-get update
apt-get install -y curl jq

# 2) Create 'runner' user and grant passwordless sudo
if ! id -u runner &>/dev/null; then
  useradd -m -s /bin/bash runner
  usermod -aG sudo runner
  cat <<EOF >/etc/sudoers.d/runner
runner ALL=(ALL) NOPASSWD:ALL
EOF
  chmod 440 /etc/sudoers.d/runner
fi

# 3) Fetch metadata attributes
MD_URL="http://metadata.google.internal/computeMetadata/v1/instance/attributes"
CURL_OPTS=(-s -H "Metadata-Flavor: Google")

REPO_OWNER=$(curl "${CURL_OPTS[@]}" "${MD_URL}/repo-owner")
REPO_NAME=$(curl "${CURL_OPTS[@]}" "${MD_URL}/repo-name")

# Fail early if required metadata is missing
if [[ -z "$REPO_OWNER" || -z "$REPO_NAME" ]]; then
  echo "Error: Missing metadata attributes." >&2
  exit 1
fi

echo "Metadata loaded: repo=$REPO_OWNER/$REPO_NAME"

# 4) Get GitHub PAT from Secret Manager and generate registration token
echo "=== Step 4: GitHub PAT retrieval and token generation ==="
echo "Starting GitHub PAT retrieval from Secret Manager..."

# Debug: Show current user and environment
echo "Debug info:"
echo "  Current user: $(whoami)"
echo "  PATH: $PATH"
echo "  gcloud version: $(gcloud version --format='value(Google Cloud SDK)' 2>/dev/null || echo 'unknown')"

# Test gcloud access first
echo "Testing gcloud authentication..."
if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" | head -n1 > /dev/null 2>&1; then
  echo "Error: No active gcloud authentication found" >&2
  echo "Available accounts:" >&2
  gcloud auth list 2>&1 >&2
  exit 1
fi

ACTIVE_ACCOUNT=$(gcloud auth list --filter=status:ACTIVE --format="value(account)" | head -n1)
echo "✓ gcloud authenticated as: $ACTIVE_ACCOUNT"

# Debug: Test gcloud project access
echo "Testing gcloud project access..."
CURRENT_PROJECT=$(gcloud config get-value project 2>/dev/null)
echo "Current project: $CURRENT_PROJECT"

echo "Retrieving GitHub PAT from Secret Manager..."
GITHUB_PAT=$(gcloud secrets versions access latest --secret="github-runner-token" 2>&1)
SECRET_EXIT_CODE=$?

if [ $SECRET_EXIT_CODE -ne 0 ]; then
  echo "Error: Failed to retrieve GitHub PAT from Secret Manager (exit code: $SECRET_EXIT_CODE)" >&2
  echo "Secret Manager error output:" >&2
  echo "$GITHUB_PAT" >&2
  
  # Additional debugging for common issues
  echo "Debugging Secret Manager access:" >&2
  echo "1. Testing Secret Manager API availability:" >&2
  gcloud secrets list --limit=1 2>&1 >&2 || echo "   Secret Manager API may not be accessible" >&2
  
  echo "2. Testing specific secret existence:" >&2
  gcloud secrets describe github-runner-token 2>&1 >&2 || echo "   Secret 'github-runner-token' may not exist" >&2
  
  echo "3. Service account info:" >&2
  gcloud auth list --format="table(account,status)" 2>&1 >&2
  
  exit 1
fi

if [ -z "$GITHUB_PAT" ]; then
  echo "Error: GitHub PAT is empty after retrieval from Secret Manager" >&2
  echo "This may indicate the secret exists but has no value" >&2
  exit 1
fi

# Validate PAT format (should start with ghp_ for personal access tokens)
if [[ ! "$GITHUB_PAT" =~ ^ghp_[a-zA-Z0-9]{36}$ ]]; then
  echo "Warning: GitHub PAT doesn't match expected format (ghp_...)" >&2
  echo "PAT format: ${GITHUB_PAT:0:10}... (showing first 10 chars)" >&2
fi

echo "✓ GitHub PAT retrieved from Secret Manager"

# Test network connectivity to GitHub API
echo "Testing connectivity to GitHub API..."
if ! curl -s --connect-timeout 10 --max-time 30 -o /dev/null https://api.github.com; then
  echo "Error: Unable to connect to GitHub API (https://api.github.com)" >&2
  echo "Check network connectivity and firewall rules" >&2
  exit 1
fi

echo "✓ GitHub API connectivity verified"

echo "Testing GitHub PAT access to repository..."
if timeout 10 curl -s --connect-timeout 3 --max-time 5 \
  -H "Authorization: Bearer $GITHUB_PAT" \
  "https://api.github.com/repos/$REPO_OWNER/$REPO_NAME" > /tmp/repo_test.json 2>/dev/null; then
    
    # Check for error in response
    if grep -q '"message"' /tmp/repo_test.json 2>/dev/null; then
        REPO_ERROR=$(grep -o '"message":"[^"]*"' /tmp/repo_test.json | cut -d'"' -f4)
        echo "Error: Cannot access repository $REPO_OWNER/$REPO_NAME" >&2
        echo "GitHub API Error: $REPO_ERROR" >&2
        
        if [[ "$REPO_ERROR" == *"Not Found"* ]]; then
            echo "Repository not found. Check if:" >&2
            echo "  1. Repository name is correct: $REPO_OWNER/$REPO_NAME" >&2
            echo "  2. PAT has access to this repository" >&2
            echo "  3. Repository is not private (or PAT has repo scope)" >&2
        elif [[ "$REPO_ERROR" == *"Bad credentials"* ]]; then
            echo "Invalid PAT credentials. Check if:" >&2
            echo "  1. PAT is correct and not expired" >&2
            echo "  2. PAT has 'repo' scope" >&2
        fi
        
        exit 1
    fi
    
    echo "✓ Repository access verified"
else
    echo "Error: Failed to test repository access" >&2
    exit 1
fi

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

# 5) Define runner version & checksum (must update together)
RUNNER_VERSION="2.325.0"
RUNNER_SHA256="5020da7139d85c776059f351e0de8fdec753affc9c558e892472d43ebeb518f4"
ARCHIVE="actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"

# 6) Download, verify, extract, and install dependencies as 'runner'
sudo -i -u runner bash <<EOF
set -euo pipefail
cd "\$HOME"
mkdir -p actions-runner && cd actions-runner

echo "Downloading GitHub Actions runner v${RUNNER_VERSION}"
curl -L -o "${ARCHIVE}" \
  "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${ARCHIVE}"

echo "Verifying checksum"
echo "${RUNNER_SHA256}  ${ARCHIVE}" | sha256sum -c -

echo "Extracting package"
tar xzf "${ARCHIVE}"

echo "Installing OS dependencies"
sudo ./bin/installdependencies.sh
EOF

# 7) Configure runner as 'runner' user, expanding variables up front
sudo -u runner bash <<EOF
set -euo pipefail
cd "\$HOME/actions-runner"

echo "Configuring GitHub Actions runner..."
./config.sh --unattended \
  --url "https://github.com/${REPO_OWNER}/${REPO_NAME}" \
  --token "${RUNNER_TOKEN}"
EOF

# 8) Install & start service as root so svc.sh sees UID 0
cd "/home/runner/actions-runner"

echo "Installing self-hosted runner service..."
sudo ./svc.sh install runner

echo "Starting self-hosted runner service..."
sudo ./svc.sh start

echo "=== Runner setup completed at $(date) ==="