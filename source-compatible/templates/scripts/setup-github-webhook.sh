#!/bin/bash
# Script to automatically register GitHub webhook

set -euo pipefail

# Configuration
REPO_OWNER="PARITY_INPUT_010"
REPO_NAME="VeraID"
WEBHOOK_URL="https://cloudbuild.googleapis.com/v1/projects/PARITY_INPUT_064/triggers/github-runner-webhook:webhook"
WEBHOOK_SECRET="PARITY_INPUT_348"

echo "🔗 Registering GitHub webhook for ${REPO_OWNER}/${REPO_NAME}..."

# Check if webhook already exists
EXISTING_WEBHOOK=$(gh api "repos/${REPO_OWNER}/${REPO_NAME}/hooks" --jq ".[] | select(.config.url == \"${WEBHOOK_URL}\") | .id" || echo "")

if [ -n "$EXISTING_WEBHOOK" ]; then
    echo "📝 Updating existing webhook (ID: $EXISTING_WEBHOOK)..."
    gh api --method PATCH "repos/${REPO_OWNER}/${REPO_NAME}/hooks/${EXISTING_WEBHOOK}" \
        --field name="web" \
        --field active=true \
        --field config[url]="${WEBHOOK_URL}" \
        --field config[content_type]="json" \
        --field config[secret]="${WEBHOOK_SECRET}" \
        --field config[insecure_ssl]="0" \
        --field events[]="workflow_job" \
        --field events[]="pull_request"
    echo "✅ Webhook updated successfully!"
else
    echo "🆕 Creating new webhook..."
    gh api --method POST "repos/${REPO_OWNER}/${REPO_NAME}/hooks" \
        --field name="web" \
        --field active=true \
        --field config[url]="${WEBHOOK_URL}" \
        --field config[content_type]="json" \
        --field config[secret]="${WEBHOOK_SECRET}" \
        --field config[insecure_ssl]="0" \
        --field events[]="workflow_job" \
        --field events[]="pull_request"
    echo "✅ Webhook created successfully!"
fi

echo "🧪 Testing webhook..."
gh api --method POST "repos/${REPO_OWNER}/${REPO_NAME}/hooks" --jq '.[0].id' | xargs -I {} gh api --method POST "repos/${REPO_OWNER}/${REPO_NAME}/hooks/{}/tests"
echo "✅ Webhook test sent!"
