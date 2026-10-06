#!/usr/bin/env bash

# Generate Cloud Function configuration from Terraform outputs
# This script should be run from the terraform directory after applying Terraform

set -e

echo "🔧 Generating Cloud Function configuration from Terraform outputs..."

# Check if we're in the terraform directory
if [ ! -f "main.tf" ]; then
    echo "❌ Error: This script must be run from the terraform directory"
    exit 1
fi

# Get Terraform outputs
echo "📋 Reading Terraform outputs..."
INFRASTRUCTURE_CONFIG=$(terraform output -json infrastructure_config)

if [ $? -ne 0 ] || [ -z "$INFRASTRUCTURE_CONFIG" ]; then
    echo "❌ Error: Could not read Terraform outputs. Make sure 'terraform apply' has been run."
    exit 1
fi

PROJECT_ID=$(echo $INFRASTRUCTURE_CONFIG | jq -r '.project_id')
ZONE=$(echo $INFRASTRUCTURE_CONFIG | jq -r '.zone')
INSTANCE_TEMPLATE_NAME=$(echo $INFRASTRUCTURE_CONFIG | jq -r '.instance_template_name')
MAX_RUNNER_VMS=$(echo $INFRASTRUCTURE_CONFIG | jq -r '.max_runner_vms')
RUNNER_COUNT=$(echo $INFRASTRUCTURE_CONFIG | jq -r '.runner_count')
WEBHOOK_HANDLER_SERVICE_ACCOUNT=$(echo "$INFRASTRUCTURE_CONFIG" | jq -r '.webhook_handler_service_account')
REQUIRED_RUNNER_LABELS_B64=$(echo "$INFRASTRUCTURE_CONFIG" | jq -c '.required_runner_labels' | base64 | tr -d '\n')
CLOUDBUILD_SERVICE_ACCOUNT=$(echo "$INFRASTRUCTURE_CONFIG" | jq -r '.cloudbuild_service_account')
REPO_OWNER=$(echo "$INFRASTRUCTURE_CONFIG" | jq -r '.github_repo_owner')
REPO_NAME=$(echo "$INFRASTRUCTURE_CONFIG" | jq -r '.github_repo_name')
MACHINE_TYPE=$(echo $INFRASTRUCTURE_CONFIG | jq -r '.machine_type')

echo "📝 Configuration values from Terraform:"
echo "  Project ID: $PROJECT_ID"
echo "  Zone: $ZONE"
echo "  Instance Template: $INSTANCE_TEMPLATE_NAME"
echo "  Max VMs: $MAX_RUNNER_VMS"
echo "  Runners per VM: $RUNNER_COUNT"
echo "  Machine Type: $MACHINE_TYPE"

# Generate environment variables for Cloud Function deployment
ENV_VARS="GOOGLE_CLOUD_PROJECT=$PROJECT_ID,DEFAULT_ZONE=$ZONE,INSTANCE_TEMPLATE_NAME=$INSTANCE_TEMPLATE_NAME,MAX_RUNNER_VMS=$MAX_RUNNER_VMS,RUNNERS_PER_VM=$RUNNER_COUNT,MACHINE_TYPE=$MACHINE_TYPE,GITHUB_WEBHOOK_SECRET_NAME=github-webhook-secret,GITHUB_REPO_OWNER=$REPO_OWNER,GITHUB_REPO_NAME=$REPO_NAME,CLOUDBUILD_SERVICE_ACCOUNT=$CLOUDBUILD_SERVICE_ACCOUNT,REQUIRED_RUNNER_LABELS_B64=$REQUIRED_RUNNER_LABELS_B64,ENABLE_SELF_HOSTED=true,LOG_EXECUTION_ID=true"

echo ""
echo "🚀 To deploy the Cloud Function with these settings, run:"
echo ""
echo "cd ../cloud-functions/webhook-handler"
echo "gcloud functions deploy webhook-handler \\"
echo "  --gen2 \\"
echo "  --runtime=nodejs20 \\"
echo "  --source=. \\"
echo "  --service-account=$WEBHOOK_HANDLER_SERVICE_ACCOUNT \\"
echo "  --entry-point=webhookHandler \\"
echo "  --trigger-http \\"
echo "  --allow-unauthenticated \\"
echo "  --region=us-central1 \\"
echo "  --set-env-vars=\"$ENV_VARS\""
echo ""

# Also save to a file for reference
cat > ../cloud-functions/webhook-handler/.env.terraform << EOF
# Generated from Terraform outputs on $(date)
# To use these values, source this file or copy to your deployment script

export GOOGLE_CLOUD_PROJECT="$PROJECT_ID"
export DEFAULT_ZONE="$ZONE"
export INSTANCE_TEMPLATE_NAME="$INSTANCE_TEMPLATE_NAME"
export MAX_RUNNER_VMS="$MAX_RUNNER_VMS"
export RUNNERS_PER_VM="$RUNNER_COUNT"
export MACHINE_TYPE="$MACHINE_TYPE"
export GITHUB_WEBHOOK_SECRET_NAME="github-webhook-secret"
export GITHUB_REPO_OWNER="$REPO_OWNER"
export GITHUB_REPO_NAME="$REPO_NAME"
export CLOUDBUILD_SERVICE_ACCOUNT="$CLOUDBUILD_SERVICE_ACCOUNT"
export REQUIRED_RUNNER_LABELS_B64="$REQUIRED_RUNNER_LABELS_B64"
export ENABLE_SELF_HOSTED="true"
export LOG_EXECUTION_ID="true"

# For gcloud deployment
export CLOUD_FUNCTION_ENV_VARS="GOOGLE_CLOUD_PROJECT=$PROJECT_ID,DEFAULT_ZONE=$ZONE,INSTANCE_TEMPLATE_NAME=$INSTANCE_TEMPLATE_NAME,MAX_RUNNER_VMS=$MAX_RUNNER_VMS,RUNNERS_PER_VM=$RUNNER_COUNT,MACHINE_TYPE=$MACHINE_TYPE,GITHUB_WEBHOOK_SECRET_NAME=github-webhook-secret,GITHUB_REPO_OWNER=$REPO_OWNER,GITHUB_REPO_NAME=$REPO_NAME,CLOUDBUILD_SERVICE_ACCOUNT=$CLOUDBUILD_SERVICE_ACCOUNT,REQUIRED_RUNNER_LABELS_B64=$REQUIRED_RUNNER_LABELS_B64,ENABLE_SELF_HOSTED=true,LOG_EXECUTION_ID=true"
EOF

echo "💾 Environment variables saved to ../cloud-functions/webhook-handler/.env.terraform"
echo ""
echo "✅ Configuration sync complete!"
