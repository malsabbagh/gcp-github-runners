#!/bin/bash

# GitHub Runner Infrastructure Setup Script
# This script sets up the complete infrastructure for GitHub runner autoscaling on GCP

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}GitHub Runner Infrastructure Setup${NC}"
echo "=================================="

# Check if required tools are installed
echo "Checking prerequisites..."

# Check gcloud
if ! command -v gcloud &> /dev/null; then
    echo -e "${RED}Error: gcloud CLI is not installed${NC}"
    echo "Please install the Google Cloud CLI: https://cloud.google.com/sdk/docs/install"
    exit 1
fi

# Check terraform
if ! command -v terraform &> /dev/null; then
    echo -e "${RED}Error: Terraform is not installed${NC}"
    echo "Please install Terraform: https://developer.hashicorp.com/terraform/downloads"
    exit 1
fi

# Check GitHub CLI (optional but recommended)
if command -v gh &> /dev/null; then
    echo -e "${GREEN}✓ GitHub CLI found${NC}"
    GH_CLI_AVAILABLE=true
else
    echo -e "${YELLOW}⚠ GitHub CLI (gh) not found - webhook setup will be manual${NC}"
    echo "Install GitHub CLI for automatic webhook setup: https://cli.github.com/"
    GH_CLI_AVAILABLE=false
fi

# Get project configuration
echo -e "${YELLOW}Please provide the following configuration:${NC}"

# Load defaults from terraform.tfvars if present
declare -A defaults
TFVARS_PATH="../terraform/terraform.tfvars"
if [ -f "$TFVARS_PATH" ]; then
    echo "Loading defaults from terraform.tfvars..."
    while IFS='=' read -r key value; do
        # Remove quotes and whitespace
        key=$(echo "$key" | xargs)
        value=$(echo "$value" | xargs | sed 's/^"//; s/"$//')
        if [[ ! "$key" =~ ^# && -n "$key" ]]; then
            defaults["$key"]="$value"
        fi
    done < "$TFVARS_PATH"
fi

# Configuration prompts with defaults - only relevant keys for GitHub runner infrastructure
declare -A config_keys=(
    ["GCP Project ID"]="project_id"
    ["GCP Region (default: us-central1)"]="region" 
    ["GCP Zone (default: us-central1-a)"]="zone"
    ["GitHub Repository Owner"]="github_repo_owner"
    ["GitHub Repository Name"]="github_repo_name"
    ["GitHub Branch (default: main)"]="github_branch"
    ["GitHub Webhook Secret (optional)"]="github_webhook_secret"
    ["Cloud Build Webhook API Key"]="webhook_api_key"
    ["GitHub Personal Access Token"]="github_pat"
    ["Instance Template Name"]="instance_template_name"
    ["Machine Type (default: c2-standard-4)"]="machine_type"
    ["Disk Size in GB (default: 20)"]="disk_size"
    ["Runner Isolation Mode (multi-user/docker)"]="runner_isolation_mode"
    ["Docker Runner Image"]="docker_runner_image"
    ["Webhook Handler Service Account Email"]="webhook_handler_sa_email"
    ["Maximum Runner VMs (default: 2)"]="max_runner_vms"
)

# Prompt for each configuration value
for prompt in "${!config_keys[@]}"; do
    key=${config_keys[$prompt]}
    default_value="${defaults[$key]}"
    
    # Handle sensitive fields
    if [[ "$key" == "github_webhook_secret" || "$key" == "github_pat" || "$key" == "webhook_api_key" ]]; then
        if [[ -n "$default_value" ]]; then
            read -sp "$prompt [***masked***]: " value
        else
            read -sp "$prompt: " value
        fi
        echo  # newline after hidden input
    else
        read -p "$prompt [$default_value]: " value
    fi
    
    # Use default if no value provided
    eval "$key=\"${value:-$default_value}\""
done

# Validate required fields
echo -e "${YELLOW}Validating configuration...${NC}"

if [[ -z "$project_id" ]]; then
    echo -e "${RED}Error: GCP Project ID is required${NC}"
    exit 1
fi

if [[ -z "$github_repo_owner" ]]; then
    echo -e "${RED}Error: GitHub Repository Owner is required${NC}"
    exit 1
fi

if [[ -z "$github_repo_name" ]]; then
    echo -e "${RED}Error: GitHub Repository Name is required${NC}"
    exit 1
fi

# Set defaults for optional fields
region="${region:-us-central1}"
zone="${zone:-us-central1-a}"
github_branch="${github_branch:-main}"
instance_template_name="${instance_template_name:-github-runner-template}"
machine_type="${machine_type:-c2-standard-4}"
disk_size="${disk_size:-20}"
runner_isolation_mode="${runner_isolation_mode:-multi-user}"
docker_runner_image="${docker_runner_image:-myoung34/github-runner:v2.325.0}"
webhook_handler_sa_email="${webhook_handler_sa_email:-webhook-handler@${project_id}.iam.gserviceaccount.com}"
max_runner_vms="${max_runner_vms:-2}"

# Generate webhook secret if not provided
if [[ -z "$github_webhook_secret" ]]; then
    github_webhook_secret=$(openssl rand -base64 32)
    echo -e "${GREEN}✓ Generated webhook secret${NC}"
fi

echo -e "${GREEN}✓ Configuration validated${NC}"

# Display configuration summary
echo ""
echo -e "${YELLOW}Configuration Summary:${NC}"
echo "====================="
echo "GCP Project ID: $project_id"
echo "GCP Region: $region"
echo "GCP Zone: $zone"
echo "GitHub Repository: $github_repo_owner/$github_repo_name"
echo "GitHub Branch: $github_branch"
echo "Instance Template: $instance_template_name"
echo "Machine Type: $machine_type"
echo "Disk Size: ${disk_size}GB"
echo "Runner Isolation: $runner_isolation_mode"
echo "Max Runner VMs: $max_runner_vms"
echo ""

# Change to terraform directory
cd ../terraform

# Generated immutable templates replace automatically through Terraform.
# The deprecated force_recreate_template flag never triggers manual deletion.

# Quote operator-provided strings and escape HCL template markers.
hcl_string() {
    jq -Rn --arg value "$1" '$value | gsub("[$][{]"; "$${") | gsub("%[{]"; "%%{")'
}

cat > terraform.tfvars << EOF
project_id = $(hcl_string "$project_id")
region     = $(hcl_string "$region")
zone       = $(hcl_string "$zone")
github_repo_owner = $(hcl_string "$github_repo_owner")
github_repo_name  = $(hcl_string "$github_repo_name")
github_branch     = $(hcl_string "$github_branch")
github_webhook_secret = $(hcl_string "$github_webhook_secret")
webhook_api_key = $(hcl_string "$webhook_api_key")
github_pat = $(hcl_string "$github_pat")
instance_template_name = $(hcl_string "$instance_template_name")
machine_type = $(hcl_string "$machine_type")
disk_size = $disk_size
runner_isolation_mode = $(hcl_string "$runner_isolation_mode")
docker_runner_image = $(hcl_string "$docker_runner_image")
webhook_handler_sa_email = $(hcl_string "$webhook_handler_sa_email")
max_runner_vms = $max_runner_vms
force_recreate_template = false
EOF

echo -e "${GREEN}✓ Configuration written to terraform.tfvars${NC}"

# Initialize and plan terraform
echo -e "${YELLOW}Initializing Terraform...${NC}"
terraform init

echo -e "${YELLOW}Planning Terraform changes...${NC}"
terraform plan

# Ask for confirmation before applying
echo ""
read -p "Do you want to apply these changes? (y/N): " apply
if [[ "$apply" =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}Applying Terraform changes...${NC}"
    if terraform apply -auto-approve; then
        echo -e "${GREEN}✓ Infrastructure deployed successfully!${NC}"
        
        # Reset force_recreate_template flag after successful apply
        if [[ "$FORCE_RECREATE" == "true" ]]; then
            echo -e "${YELLOW}Resetting force_recreate_template flag...${NC}"
            sed -i 's/force_recreate_template = true/force_recreate_template = false/' terraform.tfvars
            echo -e "${GREEN}✓ Force recreate template flag reset to false${NC}"
        fi
        
        # Get outputs
        echo -e "${YELLOW}Getting deployment outputs...${NC}"
        WEBHOOK_URL=$(terraform output -raw webhook_url 2>/dev/null || echo "")
        WEBHOOK_SECRET=$github_webhook_secret
        
        # Setup GitHub webhook
        if [[ -z "$WEBHOOK_URL" ]]; then
            echo "Configure webhook_api_key and github_webhook_secret before creating the GitHub hook."
            exit 1
        fi
        if [[ -n "$WEBHOOK_URL" ]]; then
            echo ""
            echo -e "${GREEN}Setting up GitHub webhook...${NC}"
            
            if [[ "$GH_CLI_AVAILABLE" == "true" && -n "$github_pat" ]]; then
                echo "Using GitHub CLI to create webhook..."
                
                # Set up webhook using GitHub CLI
                if echo "$github_pat" | gh auth login --with-token 2>/dev/null; then
                    # Keep credentials in stdin; never interpolate a shell command.
                    webhook_json=$(jq -n --arg url "$WEBHOOK_URL" --arg secret "$WEBHOOK_SECRET" '{name:"web", active:true, events:["workflow_job"], config:{url:$url, secret:$secret, content_type:"json", insecure_ssl:"0"}}')
                    if gh api "repos/$github_repo_owner/$github_repo_name/hooks" --method POST --input - <<< "$webhook_json" >/dev/null 2>&1; then
                        echo -e "${GREEN}✓ GitHub webhook created successfully!${NC}"
                    else
                        echo -e "${YELLOW}⚠ Failed to create webhook automatically. Please create it manually.${NC}"
                        echo "Use the sensitive webhook_url Terraform output locally; it contains credentials."
                        echo "Secret: use your configured GitHub webhook secret locally"
                    fi
                else
                    echo -e "${YELLOW}⚠ GitHub CLI authentication failed. Please create webhook manually.${NC}"
                    echo "Use the sensitive webhook_url Terraform output locally; it contains credentials."
                    echo "Secret: use your configured GitHub webhook secret locally"
                fi
            else
                echo -e "${YELLOW}Please manually create a GitHub webhook with the following details:${NC}"
                echo ""
                echo "Repository: https://github.com/$github_repo_owner/$github_repo_name/settings/hooks"
                echo "Payload URL: use the sensitive webhook_url Terraform output locally"
                echo "Content type: application/json"
                echo "Secret: use your configured GitHub webhook secret locally"
                echo "Events: 'Workflow jobs' (workflow_job)"
                echo ""
            fi
        fi
        
        echo ""
        echo -e "${GREEN}🎉 GitHub Runner Infrastructure Setup Complete!${NC}"
        echo ""
        echo "Next steps:"
        echo "1. Verify the webhook is set up in your GitHub repository"
        echo "2. Create a test workflow to verify runner scaling"
        echo "3. Monitor Cloud Function logs and instance creation"
        echo ""
        echo "For troubleshooting, check:"
        echo "- Cloud Function logs: https://console.cloud.google.com/functions"
        echo "- Compute instances: https://console.cloud.google.com/compute/instances"
        echo "- Cloud Build triggers: https://console.cloud.google.com/cloud-build/triggers"
        
    else
        echo -e "${RED}Error: Terraform apply failed${NC}"
        exit 1
    fi
else
    echo "Apply cancelled by user."
fi
