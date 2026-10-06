#!/bin/bash

# Manual cleanup script for GitHub runners
# Usage: ./manual-cleanup.sh [immediate|scheduled|specific-runner-name]

set -e

CLEANUP_TYPE=${1:-"scheduled"}
PUBSUB_TOPIC="runner-cleanup-trigger"

case "$CLEANUP_TYPE" in
  "immediate")
    echo "🚀 Triggering immediate cleanup of all runners..."
    gcloud pubsub topics publish $PUBSUB_TOPIC \
      --message='{
        "action": "cleanup_immediate",
        "trigger": "manual_immediate",
        "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%S.000Z)'"
      }'
    ;;
  
  "scheduled")
    echo "⏰ Triggering scheduled cleanup (2+ hours old)..."
    gcloud pubsub topics publish $PUBSUB_TOPIC \
      --message='{
        "action": "cleanup",
        "trigger": "manual_scheduled", 
        "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%S.000Z)'"
      }'
    ;;
  
  *)
    # Assume it's a specific runner name
    RUNNER_NAME="$CLEANUP_TYPE"
    echo "🎯 Triggering cleanup for specific runner: $RUNNER_NAME"
    gcloud pubsub topics publish $PUBSUB_TOPIC \
      --message='{
        "action": "cleanup_immediate",
        "trigger": "manual_specific",
        "runner_name": "'$RUNNER_NAME'",
        "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%S.000Z)'"
      }'
    ;;
esac

echo "✅ Cleanup request sent to Pub/Sub topic: $PUBSUB_TOPIC"
echo "📋 Check Cloud Build logs to monitor cleanup progress"

# Optional: Show recent builds
echo ""
echo "Recent cleanup builds:"
gcloud builds list --filter="trigger.name=runner-cleanup-trigger" --limit=3 --format="table(id,status,createTime,duration)"
