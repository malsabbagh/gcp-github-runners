# PowerShell script to create or update the GitHub runner instance template
# This script can be used to maintain the instance template

$ErrorActionPreference = "Stop"

Write-Host "GitHub Runner Instance Template Management" -ForegroundColor Green
Write-Host "========================================="

# Configuration
$TEMPLATE_NAME = "github-runner-c2-4-16-spot"
$MACHINE_TYPE = "c2-standard-4"
$IMAGE_FAMILY = "debian-12"
$IMAGE_PROJECT = "PARITY_INPUT_337"
$DISK_SIZE = "100"
$DISK_TYPE = "pd-ssd"

# Get project configuration
$PROJECT_ID = Read-Host "GCP Project ID"
if ([string]::IsNullOrEmpty($PROJECT_ID)) {
    Write-Error "Project ID is required"
    exit 1
}

$REGION = Read-Host "GCP Region (default: us-central1)"
if ([string]::IsNullOrEmpty($REGION)) {
    $REGION = "us-central1"
}

gcloud config set project $PROJECT_ID

# Create startup script (use canonical version from cloudbuild directory)
$STARTUP_SCRIPT_PATH = Join-Path (Split-Path $PSScriptRoot -Parent) "cloudbuild\runner-startup.sh"
if (Test-Path $STARTUP_SCRIPT_PATH) {
    Write-Host "Using canonical startup script from cloudbuild directory"
    $STARTUP_SCRIPT_SOURCE = $STARTUP_SCRIPT_PATH
}
else {
    Write-Host "Warning: Canonical startup script not found, creating inline version" -ForegroundColor Yellow
    $STARTUP_SCRIPT_SOURCE = "$env:TEMP\runner-startup-script.sh"
    
    $startupScript = @'
#!/bin/bash

# GitHub Actions Runner Startup Script for Instance Template
set -e

# Log all output
exec > >(tee -a /var/log/runner-startup.log)
exec 2>&1

echo "Starting GitHub Actions Runner setup at $(date)"

# Update system packages
sudo apt-get update -y
sudo apt-get install -y curl wget jq libdigest-sha-perl docker.io

# Start and enable Docker
sudo systemctl start docker
sudo systemctl enable docker

# Get metadata from instance
REPO_OWNER=$(curl -s "http://metadata.google.internal/computeMetadata/v1/instance/attributes/repo-owner" -H "Metadata-Flavor: Google" || echo "")
REPO_NAME=$(curl -s "http://metadata.google.internal/computeMetadata/v1/instance/attributes/repo-name" -H "Metadata-Flavor: Google" || echo "")
RUNNER_TOKEN=$(curl -s "http://metadata.google.internal/computeMetadata/v1/instance/attributes/runner-token" -H "Metadata-Flavor: Google" || echo "")

# Create runner user
sudo useradd -m -s /bin/bash runner || true
sudo usermod -aG sudo,docker runner
echo "runner ALL=(ALL) NOPASSWD:ALL" | sudo tee /etc/sudoers.d/runner

# Set up actions runner as runner user
sudo -u runner bash << 'INNER_EOF'
cd /home/runner
mkdir -p actions-runner && cd actions-runner

# Download GitHub Actions runner
RUNNER_VERSION="2.325.0"
curl -o actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz -L https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz

# Verify download
echo "5020da7139d85c776059f351e0de8fdec753affc9c558e892472d43ebeb518f4  actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" | shasum -a 256 -c

# Extract runner
tar xzf ./actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz

# Configure runner if token is provided
if [ -n "${RUNNER_TOKEN}" ] && [ -n "${REPO_OWNER}" ] && [ -n "${REPO_NAME}" ]; then
    REPO_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}"
    RUNNER_NAME="gcp-runner-$(hostname)-$(date +%s)"
    ./config.sh --url "${REPO_URL}" --token "${RUNNER_TOKEN}" --name "${RUNNER_NAME}" --unattended --replace --labels self-hosted,linux,x64,gcp
fi
INNER_EOF

# Install runner as a service
cd /home/runner/actions-runner
sudo ./svc.sh install runner

# Create shutdown monitor script
cat > /usr/local/bin/shutdown-monitor.sh << 'SHUTDOWN_EOF'
#!/bin/bash
# Monitor for runner completion and shutdown
while true; do
    if ! systemctl is-active --quiet actions.runner.*.service 2>/dev/null; then
        echo "Runner service stopped, shutting down instance..."
        sudo shutdown -h +1 "Runner job completed, shutting down in 1 minute"
        break
    fi
    sleep 30
done
SHUTDOWN_EOF

chmod +x /usr/local/bin/shutdown-monitor.sh

# Start runner service
sudo ./svc.sh start

# Start shutdown monitor in background
nohup /usr/local/bin/shutdown-monitor.sh > /var/log/shutdown-monitor.log 2>&1 &

echo "GitHub Actions Runner setup completed at $(date)"
'@
    
    $startupScript | Out-File -FilePath $STARTUP_SCRIPT_SOURCE -Encoding UTF8
}

Write-Host "Creating instance template: $TEMPLATE_NAME"

# Create the instance template
gcloud compute instance-templates create $TEMPLATE_NAME `
    --machine-type=$MACHINE_TYPE `
    --image-family=$IMAGE_FAMILY `
    --image-project=$IMAGE_PROJECT `
    --boot-disk-size=$DISK_SIZE `
    --boot-disk-type=$DISK_TYPE `
    --boot-disk-device-name=$TEMPLATE_NAME `
    --tags="https-server" `
    --scopes="https://www.googleapis.com/auth/devstorage.read_only,https://www.googleapis.com/auth/logging.write,https://www.googleapis.com/auth/monitoring.write,https://www.googleapis.com/auth/servicecontrol,https://www.googleapis.com/auth/service.management.readonly,https://www.googleapis.com/auth/trace.append" `
    --metadata-from-file="startup-script=$STARTUP_SCRIPT_SOURCE" `
    --provisioning-model="SPOT" `
    --instance-termination-action="DELETE" `
    --region=$REGION

Write-Host "Instance template '$TEMPLATE_NAME' created successfully" -ForegroundColor Green

# Clean up temporary file if created
if ($STARTUP_SCRIPT_SOURCE -eq "$env:TEMP\runner-startup-script.sh") {
    Remove-Item -Path $STARTUP_SCRIPT_SOURCE -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "Template details:"
gcloud compute instance-templates describe $TEMPLATE_NAME --region=$REGION
