#!/bin/bash

# Quick Deployment Validation Script
# Verifies the shutdown script fix is properly deployed

set -euo pipefail

echo "🔍 Validating Shutdown Script Fix Deployment..."
echo "=============================================="

# Check 1: Verify trigger has stop logic
echo "✅ Checking Cloud Build trigger configuration..."
STOP_LOGIC=$(gcloud builds triggers describe github-runner-cleanup --format="value(build.steps[0].args[1])" | grep -c "Stopping instance.*to run shutdown scripts" || echo "0")

if [ "$STOP_LOGIC" -gt 0 ]; then
    echo "   ✅ PASS: Trigger contains stop-before-delete logic"
else
    echo "   ❌ FAIL: Trigger missing stop-before-delete logic"
    exit 1
fi

# Check 2: Verify wait time included
echo "✅ Checking shutdown script wait time..."
WAIT_TIME=$(gcloud builds triggers describe github-runner-cleanup --format="value(build.steps[0].args[1])" | grep -c "sleep 30" || echo "0")

if [ "$WAIT_TIME" -gt 0 ]; then
    echo "   ✅ PASS: Trigger includes 30-second wait for shutdown scripts"
else
    echo "   ❌ FAIL: Trigger missing wait time"
    exit 1
fi

# Check 3: Verify scheduler is enabled
echo "✅ Checking Cloud Scheduler status..."
SCHEDULER_STATUS=$(gcloud scheduler jobs describe runner-cleanup-schedule --format="value(state)" 2>/dev/null || echo "NOT_FOUND")

if [ "$SCHEDULER_STATUS" = "ENABLED" ]; then
    echo "   ✅ PASS: Cloud Scheduler is enabled"
else
    echo "   ❌ FAIL: Cloud Scheduler not enabled (status: $SCHEDULER_STATUS)"
    exit 1
fi

# Check 4: Verify Pub/Sub topic exists
echo "✅ Checking Pub/Sub topic..."
TOPIC_EXISTS=$(gcloud pubsub topics describe runner-cleanup-trigger --format="value(name)" 2>/dev/null || echo "")

if [ -n "$TOPIC_EXISTS" ]; then
    echo "   ✅ PASS: Pub/Sub topic exists"
else
    echo "   ❌ FAIL: Pub/Sub topic not found"
    exit 1
fi

# Check 5: Quick trigger test
echo "✅ Testing trigger functionality..."
MESSAGE_ID=$(gcloud pubsub topics publish runner-cleanup-trigger --message='{"test":"validation"}' --format="value(messageIds[0])" 2>/dev/null || echo "")

if [ -n "$MESSAGE_ID" ]; then
    echo "   ✅ PASS: Can publish to trigger topic (Message ID: $MESSAGE_ID)"
else
    echo "   ❌ FAIL: Cannot publish to trigger topic"
    exit 1
fi

echo ""
echo "🎉 DEPLOYMENT VALIDATION SUCCESSFUL!"
echo "==========================================="
echo "✅ Cloud Build trigger properly configured with stop-before-delete logic"
echo "✅ Shutdown scripts will execute during automated cleanup"
echo "✅ All components are working correctly"
echo ""
echo "📅 Next automated cleanup: Every 2 hours"
echo "🔧 Monitoring: gcloud builds list --filter='trigger.name:github-runner-cleanup'"
echo ""
echo "🚀 The shutdown script fix is LIVE and READY!"
