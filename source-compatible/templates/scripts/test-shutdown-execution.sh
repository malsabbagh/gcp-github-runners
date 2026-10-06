#!/bin/bash
# Test script to verify shutdown script execution and timing

echo "=== Shutdown Script Execution Test ==="
echo "This script will create a very short-lived test instance to check if shutdown scripts actually execute"

# Create a minimal test instance with a simple shutdown script
gcloud compute instances create shutdown-test-$(date +%s) \
  --zone=us-central1-a \
  --machine-type=e2-micro \
  --image-family=debian-12 \
  --image-project=PARITY_INPUT_337 \
  --metadata=shutdown-script='#!/bin/bash
echo "=== SHUTDOWN SCRIPT STARTED at $(date) ===" | tee /tmp/shutdown-proof.log
echo "Testing network connectivity..." | tee -a /tmp/shutdown-proof.log
curl -s -o /dev/null -w "GitHub API HTTP: %{http_code}\n" https://api.github.com >> /tmp/shutdown-proof.log 2>&1
echo "Sleeping for 30 seconds to test timing..." | tee -a /tmp/shutdown-proof.log
sleep 30
echo "=== SHUTDOWN SCRIPT COMPLETED at $(date) ===" | tee -a /tmp/shutdown-proof.log
# Upload proof to a persistent location
gsutil cp /tmp/shutdown-proof.log gs://your-test-bucket/shutdown-proof-$(date +%s).log 2>/dev/null || echo "Failed to upload proof"
' \
  --metadata=shutdown-script-timeout=120 \
  --scopes=https://www.googleapis.com/auth/cloud-platform

echo "Test instance created. It will be deleted in 60 seconds..."
sleep 60

echo "Deleting test instance to trigger shutdown script..."
INSTANCE_NAME=$(gcloud compute instances list --zones=us-central1-a --filter="name~shutdown-test" --format="value(name)" | head -1)

if [ -n "$INSTANCE_NAME" ]; then
  echo "Deleting instance: $INSTANCE_NAME"
  gcloud compute instances delete "$INSTANCE_NAME" --zone=us-central1-a --quiet
  echo "Instance deleted. Shutdown script should have executed during deletion."
else
  echo "No test instance found"
fi

echo "=== Test completed ==="
echo "If the shutdown script executed properly, it should have:"
echo "1. Created /tmp/shutdown-proof.log on the VM"
echo "2. Tested GitHub API connectivity"
echo "3. Completed within the 120-second timeout"
echo ""
echo "The real issue may be:"
echo "- Network connectivity lost during shutdown"
echo "- VM terminated before script completion"
echo "- Environment/dependency issues during shutdown"
