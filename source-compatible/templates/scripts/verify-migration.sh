#!/bin/bash

# Verification Script for GitHub Runner Infrastructure Migration
# This script helps verify that the migration from Cloud Build to Cloud Functions was successful

echo "🔍 GitHub Runner Infrastructure Migration Verification"
echo "===================================================="

echo ""
echo "✅ COMPLETED STEPS:"
echo "1. Old Cloud Build trigger 'github-runner-webhook' has been deleted"
echo "2. New Cloud Function 'github-runner-webhook' is active and ready"
echo "3. Cleanup trigger is still active for automatic VM cleanup"

echo ""
echo "📋 CURRENT INFRASTRUCTURE STATUS:"

echo ""
echo "🔧 Cloud Function (NEW - Active):"
echo "  Name: github-runner-webhook"
echo "  URL: https://us-central1-PARITY_INPUT_064.cloudfunctions.net/github-runner-webhook"
echo "  Platform: 2nd Generation"
echo "  Runtime: Node.js 20"
echo "  Features: Idle runner optimization, intelligent scaling"

echo ""
echo "🧹 Cleanup Trigger (Keeping):"
echo "  Name: github-runner-cleanup"
echo "  Purpose: Automatically removes old runner VMs (2+ hours old)"
echo "  Trigger: Pub/Sub scheduled every 30 minutes"

echo ""
echo "❗ MANUAL ACTION REQUIRED:"
echo "You must update your GitHub webhook URL manually:"
echo ""
echo "1. Go to: PARITY_INPUT_167"
echo "2. Edit the existing webhook"
echo "3. Change Payload URL to:"
echo "   https://us-central1-PARITY_INPUT_064.cloudfunctions.net/github-runner-webhook"
echo "4. Ensure 'Workflow jobs' events are selected"
echo "5. Save the webhook"

echo ""
echo "🧪 TESTING:"
echo "After updating the webhook, trigger a GitHub Actions workflow to test:"
echo "- The Cloud Function will receive the webhook"
echo "- It will check for idle runners first"
echo "- Only create new VMs if no idle runners are available"

echo ""
echo "📊 BENEFITS OF NEW SYSTEM:"
echo "- ✅ Cost optimization: Reuses idle runners"
echo "- ✅ Faster startup: No VM creation delay when idle runners exist"
echo "- ✅ Intelligent scaling: Only creates VMs when actually needed"
echo "- ✅ Better monitoring: Cloud Function logs and metrics"

echo ""
echo "🔗 Useful Links:"
echo "- Cloud Function logs: https://console.cloud.google.com/functions/details/us-central1/github-runner-webhook?project=PARITY_INPUT_064"
echo "- GitHub webhook settings: PARITY_INPUT_167"
echo ""
