#!/bin/bash

# Script to destroy all infrastructure resources
# Use with caution - this will delete all resources created by this infrastructure

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${RED}GitHub Runner Infrastructure Destruction${NC}"
echo "========================================"
echo -e "${YELLOW}WARNING: This will destroy all infrastructure resources!${NC}"

# Confirmation
read -p "Are you sure you want to destroy all resources? (y/N): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Destruction cancelled."
    exit 0
fi

read -p "Type 'destroy' to confirm: " CONFIRM
if [ "$CONFIRM" != "destroy" ]; then
    echo "Confirmation failed. Destruction cancelled."
    exit 0
fi

# Check if we're in the right directory
if [ ! -f "terraform/main.tf" ]; then
    echo -e "${RED}Error: terraform/main.tf not found${NC}"
    echo "Please run this script from the repository root directory."
    exit 1
fi

# Destroy Terraform resources
echo "Destroying Terraform resources..."
cd terraform

if [ -f "terraform.tfstate" ]; then
    terraform destroy -auto-approve
    echo -e "${GREEN}Terraform resources destroyed${NC}"
else
    echo -e "${YELLOW}No terraform.tfstate found, skipping Terraform destroy${NC}"
fi

# Clean up any remaining runner instances manually
echo "Cleaning up any remaining runner instances..."
cd ..

# Get project ID from terraform.tfvars if it exists
PROJECT_ID=""
if [ -f "terraform/terraform.tfvars" ]; then
    PROJECT_ID=$(grep -E "^project_id" terraform/terraform.tfvars | cut -d'"' -f2)
fi

if [ -n "$PROJECT_ID" ]; then
    echo "Using project ID: $PROJECT_ID"
    gcloud config set project "$PROJECT_ID"
    
    # Find and delete any remaining runner instances
    echo "Looking for remaining runner instances..."
    INSTANCES=$(gcloud compute instances list --filter="labels.purpose=github-runner" --format="value(name,zone)" 2>/dev/null || true)
    
    if [ -n "$INSTANCES" ]; then
        echo "Found remaining runner instances, deleting..."
        echo "$INSTANCES" | while read INSTANCE_NAME INSTANCE_ZONE; do
            if [ -n "$INSTANCE_NAME" ] && [ -n "$INSTANCE_ZONE" ]; then
                echo "Deleting instance: $INSTANCE_NAME in zone $INSTANCE_ZONE"
                gcloud compute instances delete "$INSTANCE_NAME" --zone="$INSTANCE_ZONE" --quiet || true
            fi
        done
    else
        echo "No remaining runner instances found"
    fi
else
    echo -e "${YELLOW}Could not determine project ID, skipping manual cleanup${NC}"
fi

echo -e "${GREEN}Destruction completed${NC}"
echo
echo "All infrastructure resources have been destroyed."
echo "You may want to also:"
echo "1. Remove any GitHub webhook configurations"
echo "2. Clean up local terraform.tfvars file if it contains sensitive data"