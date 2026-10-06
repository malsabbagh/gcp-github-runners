#!/bin/bash
# Manual cleanup script for GitHub runner VMs
# Run this when workflows complete

echo "🧹 Starting GitHub runner VM cleanup..."

# Find and delete old runner instances (older than 1 hour)
CUTOFF_TIME=$(date -d '1 hour ago' -u +%Y-%m-%dT%H:%M:%S.000Z)

echo "Looking for instances older than: $CUTOFF_TIME"

gcloud compute instances list \
  --filter="labels.purpose=github-runner AND creationTimestamp<$CUTOFF_TIME" \
  --format="value(name,zone)" | while read name zone; do
  if [ -n "$name" ]; then
    echo "🗑️ Deleting instance: $name in zone $zone"
    gcloud compute instances delete "$name" --zone="$zone" --quiet
  fi
done

echo "✅ Cleanup completed!"
