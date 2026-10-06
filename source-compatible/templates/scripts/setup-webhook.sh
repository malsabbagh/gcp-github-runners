#!/bin/bash

# GitHub Webhook Setup Script
# This script helps configure GitHub webhooks for automatic runner deployment

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${GREEN}GitHub Webhook Setup for Runner Auto-Deployment${NC}"
echo "=================================================="

# Check if required tools are installed
check_tools() {
    echo "Checking prerequisites..."
    
    if ! command -v gcloud &> /dev/null; then
        echo -e "${RED}Error: gcloud CLI is not installed${NC}"
        exit 1
    fi
    
    if ! command -v gh &> /dev/null; then
        echo -e "${YELLOW}Warning: GitHub CLI (gh) is not installed${NC}"
        echo "You'll need to configure the webhook manually via GitHub web interface"
        MANUAL_SETUP=true
    else
        MANUAL_SETUP=false
    fi
}

# Get webhook URL from Cloud Build trigger
get_webhook_url() {
    local script_dir
    script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
    WEBHOOK_URL=$(terraform -chdir="$script_dir/../terraform" output -raw webhook_url)
    TRIGGER_ID=$(terraform -chdir="$script_dir/../terraform" output -raw github_trigger_id)
    if [ -z "$WEBHOOK_URL" ] || [ -z "$TRIGGER_ID" ]; then
        echo "Configure webhook_api_key and github_webhook_secret in Terraform before webhook setup." >&2
        exit 1
    fi
    echo "Loaded the managed authenticated webhook endpoint (credentials hidden)."
}

# Configure GitHub webhook
setup_webhook() {
    echo "Setting up GitHub webhook..."
    
    read -p "GitHub repository owner/organization: " REPO_OWNER
    read -p "GitHub repository name: " REPO_NAME
    read -s -p "Webhook secret (from terraform.tfvars): " WEBHOOK_SECRET
    echo
    
    if [ "$MANUAL_SETUP" = true ]; then
        echo -e "${YELLOW}Manual Setup Required:${NC}"
        echo "1. Go to: https://github.com/${REPO_OWNER}/${REPO_NAME}/settings/hooks"
        echo "2. Click 'Add webhook'"
        echo "3. Use these settings:"
        echo "   - Payload URL: use the sensitive webhook_url Terraform output locally"
        echo "   - Content type: application/json"
        echo "   - Secret: [your webhook secret]"
        echo "   - Events: Workflow jobs"
        echo "4. Click 'Add webhook'"
        return
    fi
    
    # Check if user is authenticated with GitHub CLI
    if ! gh auth status &> /dev/null; then
        echo "Please authenticate with GitHub CLI first:"
        echo "gh auth login"
        exit 1
    fi
    
    # Create the webhook using GitHub CLI
    echo "Creating webhook..."
    
    WEBHOOK_CONFIG=$(jq -n --arg url "$WEBHOOK_URL" --arg secret "$WEBHOOK_SECRET" '{name:"web",active:true,events:["workflow_job"],config:{url:$url,secret:$secret,content_type:"json",insecure_ssl:"0"}}')

    if gh api "repos/${REPO_OWNER}/${REPO_NAME}/hooks" --method POST --input - <<< "$WEBHOOK_CONFIG" > /dev/null; then
        echo -e "${GREEN}✓ Webhook created successfully!${NC}"
    else
        echo -e "${RED}✗ Failed to create webhook${NC}"
        echo "Please check your repository permissions and try manual setup"
        exit 1
    fi
}

# Test the webhook
test_webhook() {
    echo "Testing webhook setup..."
    
    read -p "Would you like to test the webhook by creating a test PR? (y/N): " -n 1 -r
    echo
    
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "Creating test branch and PR..."
        
        original_directory=$PWD
        git_root=$(git rev-parse --show-toplevel)
        cd "$git_root"

        # Create a test branch
        TEST_BRANCH="test-webhook-$(date +%s)"
        git checkout -b "$TEST_BRANCH"
        
        # Make a small change
        echo "# Test Webhook - $(date)" >> test-webhook.md
        git add test-webhook.md
        git commit -m "Test webhook trigger for runner deployment"
        git push origin "$TEST_BRANCH"
        
        # Create PR
        gh pr create --title "Test Webhook Integration" --body "This PR tests the webhook integration for automatic runner deployment. This can be closed after testing."
        
        cd "$original_directory"
        echo -e "${GREEN}✓ Test PR created!${NC}"
        echo "Check Cloud Build logs to see if the runner was created:"
        echo "  gcloud builds list --limit 5"
        echo "  gcloud compute instances list --filter='labels.purpose=github-runner'"
    fi
}

# Main execution
main() {
    check_tools
    get_webhook_url
    setup_webhook
    
    echo
    echo -e "${GREEN}Webhook setup completed!${NC}"
    echo
    echo "Your repository is now configured to automatically deploy runners for:"
    echo "  - Workflow job events (queued)"
    echo
    
    test_webhook
    
    echo
    echo -e "${BLUE}Monitoring Commands:${NC}"
    echo "  # Check recent builds"
    echo "  gcloud builds list --limit 10"
    echo
    echo "  # Check active runners"
    echo "  gcloud compute instances list --filter='labels.purpose=github-runner'"
    echo
    echo "  # View webhook deliveries in GitHub"
    echo "  https://github.com/${REPO_OWNER}/${REPO_NAME}/settings/hooks"
}

# Run main function
main "$@"
