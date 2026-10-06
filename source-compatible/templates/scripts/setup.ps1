# GitHub Runner Infrastructure Setup Script (PowerShell)
# This script sets up the complete infrastructure for GitHub runner autoscaling on GCP

$ErrorActionPreference = "Stop"

# Colors for output
$Red = "Red"
$Green = "Green"
$Yellow = "Yellow"

Write-Host "GitHub Runner Infrastructure Setup" -ForegroundColor $Green
Write-Host "==================================="

# Check if required tools are installed
Write-Host "Checking prerequisites..." -ForegroundColor $Yellow

# Check gcloud
try {
    $null = Get-Command gcloud -ErrorAction Stop
    Write-Host "✓ gcloud CLI found" -ForegroundColor $Green
}
catch {
    Write-Host "✗ Error: gcloud CLI is not installed" -ForegroundColor $Red
    Write-Host "Please install the Google Cloud CLI: https://cloud.google.com/sdk/docs/install-sdk#windows" -ForegroundColor $Yellow
    Write-Host "Or use: choco install gcloudsdk (if you have Chocolatey)" -ForegroundColor $Yellow
    exit 1
}

# Check terraform
try {
    $null = Get-Command terraform -ErrorAction Stop
    Write-Host "✓ Terraform found" -ForegroundColor $Green
}
catch {
    Write-Host "✗ Error: Terraform is not installed" -ForegroundColor $Red
    Write-Host "Please install Terraform: https://developer.hashicorp.com/terraform/downloads" -ForegroundColor $Yellow
    Write-Host "Or use: choco install terraform (if you have Chocolatey)" -ForegroundColor $Yellow
    exit 1
}

# Check GitHub CLI (optional but recommended)
try {
    $null = Get-Command gh -ErrorAction Stop
    Write-Host "✓ GitHub CLI found" -ForegroundColor $Green
    $ghCliAvailable = $true
}
catch {
    Write-Host "⚠ GitHub CLI (gh) not found - webhook setup will be manual" -ForegroundColor $Yellow
    Write-Host "Install GitHub CLI for automatic webhook setup: https://cli.github.com/" -ForegroundColor $Yellow
    $ghCliAvailable = $false
}

# Load defaults from terraform.tfvars if present
$terraformDir = Join-Path $PSScriptRoot "..\terraform"
$tfvarsPath = Join-Path $terraformDir "terraform.tfvars"
$defaults = @{}
if (Test-Path $tfvarsPath) {
    $lines = Get-Content $tfvarsPath
    foreach ($line in $lines) {
        if ($line -match '^\s*webhook_api_key\s*=\s*("(?:[^"\\]|\\.)*")\s*(?:#.*)?$') {
            # Decode the quoted value written by ConvertTo-HclString, including
            # escaped quotes and literal HCL template markers.
            $defaults['webhook_api_key'] = ($matches[1] | ConvertFrom-Json).Replace('$${', '${').Replace('%%{', '%{')
        }
        elseif ($line -match '^(\w+)\s*=\s*"([^"]*)"') {
            $defaults[$matches[1]] = $matches[2]
        }
    }
}

# Prompt for config, using defaults if available
$PROJECT_ID = Read-Host "GCP Project ID [$($defaults['project_id'])]"
if ([string]::IsNullOrWhiteSpace($PROJECT_ID)) { $PROJECT_ID = $defaults['project_id'] }

$REGION = Read-Host "GCP Region (default: us-central1) [$($defaults['region'])]"
if ([string]::IsNullOrWhiteSpace($REGION)) { $REGION = $defaults['region'] }
if ([string]::IsNullOrWhiteSpace($REGION)) { $REGION = "us-central1" }

$ZONE = Read-Host "GCP Zone (default: us-central1-a) [$($defaults['zone'])]"
if ([string]::IsNullOrWhiteSpace($ZONE)) { $ZONE = $defaults['zone'] }
if ([string]::IsNullOrWhiteSpace($ZONE)) { $ZONE = "us-central1-a" }

$WEBHOOK_SECRET_PLAIN = $null
$defaultSecret = $defaults['github_webhook_secret']
$WEBHOOK_SECRET = Read-Host "GitHub Webhook Secret (optional, press enter to auto-generate) [***masked***]" -AsSecureString
if ($WEBHOOK_SECRET.Length -gt 0) {
    $WEBHOOK_SECRET_PLAIN = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($WEBHOOK_SECRET))
}
elseif ($defaultSecret) {
    $WEBHOOK_SECRET_PLAIN = $defaultSecret
}
else {
    # Generate a strong random webhook secret
    $WEBHOOK_SECRET_PLAIN = -join ((1..32) | ForEach-Object { [char]((65..90) + (97..122) + (48..57) | Get-Random) })
    Write-Host "✓ Generated webhook secret (hidden)" -ForegroundColor $Green
}

Write-Host ""; Write-Host "GitHub Runner Token Setup:" -ForegroundColor $Yellow
Write-Host "This token is used to generate runner registration tokens dynamically." -ForegroundColor $Yellow
Write-Host "Required scopes: repo, workflow, admin:repo_hook" -ForegroundColor $Yellow
Write-Host "Create token at: https://github.com/settings/tokens" -ForegroundColor $Yellow
$defaultToken = $defaults['github_token']
do {
    $GITHUB_TOKEN = Read-Host "GitHub Runner Token (ghp_...) [$defaultToken]" -AsSecureString
    if ($GITHUB_TOKEN.Length -eq 0 -and $defaultToken) {
        $GITHUB_TOKEN_PLAIN = $defaultToken
        break
    }
    elseif ($GITHUB_TOKEN.Length -eq 0) {
        Write-Host "GitHub token is required for dynamic runner token generation." -ForegroundColor $Red
    }
    else {
        $GITHUB_TOKEN_PLAIN = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($GITHUB_TOKEN))
        break
    }
} while ($true)

$defaultOwner = $defaults['github_repo_owner']
do {
    $GITHUB_REPO_OWNER = Read-Host "GitHub Repository Owner/Organization [$defaultOwner]"
    if ([string]::IsNullOrWhiteSpace($GITHUB_REPO_OWNER)) { $GITHUB_REPO_OWNER = $defaultOwner }
} while ([string]::IsNullOrWhiteSpace($GITHUB_REPO_OWNER))

$defaultName = $defaults['github_repo_name']
do {
    $GITHUB_REPO_NAME = Read-Host "GitHub Repository Name [$defaultName]"
    if ([string]::IsNullOrWhiteSpace($GITHUB_REPO_NAME)) { $GITHUB_REPO_NAME = $defaultName }
} while ([string]::IsNullOrWhiteSpace($GITHUB_REPO_NAME))

$defaultBranch = $defaults['github_branch']
$GITHUB_BRANCH = Read-Host "GitHub Branch (default: main) [$defaultBranch]"
if ([string]::IsNullOrWhiteSpace($GITHUB_BRANCH)) { $GITHUB_BRANCH = $defaultBranch }
if ([string]::IsNullOrWhiteSpace($GITHUB_BRANCH)) { $GITHUB_BRANCH = "main" }

# Verify gcloud authentication
Write-Host "Verifying gcloud authentication..." -ForegroundColor $Yellow
try {
    $activeAccount = & gcloud auth list --filter="status:ACTIVE" --format="value(account)" | Select-Object -First 1
    if ([string]::IsNullOrWhiteSpace($activeAccount)) {
        throw "No active account found"
    }
    Write-Host "✓ Authenticated as: $activeAccount" -ForegroundColor $Green
}
catch {
    Write-Host "✗ Error: No active gcloud authentication found" -ForegroundColor $Red
    Write-Host "Please run: gcloud auth login" -ForegroundColor $Yellow
    exit 1
}

# Set the project
Write-Host "Setting gcloud project to $PROJECT_ID..." -ForegroundColor $Yellow
& gcloud config set project $PROJECT_ID
if ($LASTEXITCODE -ne 0) {
    Write-Host "✗ Error setting project" -ForegroundColor $Red
    exit 1
}

# Enable required APIs
Write-Host "Enabling required GCP APIs..." -ForegroundColor $Yellow
& gcloud services enable cloudbuild.googleapis.com cloudscheduler.googleapis.com compute.googleapis.com pubsub.googleapis.com
if ($LASTEXITCODE -ne 0) {
    Write-Host "✗ Error enabling APIs" -ForegroundColor $Red
    exit 1
}

# Verify the instance template exists
Write-Host "Verifying instance template 'github-runner-c2-4-16-spot' exists..." -ForegroundColor $Yellow
try {
    & gcloud compute instance-templates describe github-runner-c2-4-16-spot --region=$REGION 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✓ Instance template found" -ForegroundColor $Green
    }
    else {
        throw "Template not found"
    }
}
catch {
    Write-Host "⚠ Warning: Instance template 'github-runner-c2-4-16-spot' not found" -ForegroundColor $Yellow
    Write-Host "The template should already exist as mentioned in the requirements." -ForegroundColor $Yellow
    Write-Host "Please ensure the template exists before proceeding." -ForegroundColor $Yellow
    $continue = Read-Host "Continue anyway? (y/N)"
    if ($continue -ne "y" -and $continue -ne "Y") {
        exit 1
    }
}

# Change to terraform directory
$terraformDir = Join-Path $PSScriptRoot "..\terraform"
if (-not (Test-Path $terraformDir)) {
    Write-Host "✗ Error: Terraform directory not found: $terraformDir" -ForegroundColor $Red
    exit 1
}

Set-Location $terraformDir

# Initialize Terraform
Write-Host "Initializing Terraform..." -ForegroundColor $Yellow
& terraform init
if ($LASTEXITCODE -ne 0) {
    Write-Host "✗ Error initializing Terraform" -ForegroundColor $Red
    exit 1
}

# Create terraform.tfvars
Write-Host "Creating terraform.tfvars..." -ForegroundColor $Yellow
function Read-WebhookApiKey {
    param([string]$DefaultValue)
    $value = Read-Host "Cloud Build Webhook API Key (enter to retain existing value) [***masked***]" -AsSecureString
    if ($value.Length -eq 0) {
        if ([string]::IsNullOrWhiteSpace($DefaultValue)) { throw "Cloud Build Webhook API Key is required" }
        return $DefaultValue
    }
    $buffer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($value)
    try {
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($buffer)
        if ([string]::IsNullOrWhiteSpace($plain)) { throw "Cloud Build Webhook API Key cannot be whitespace" }
        return $plain
    }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($buffer) }
}
$WEBHOOK_API_KEY_PLAIN = Read-WebhookApiKey -DefaultValue $defaults['webhook_api_key']
# Quote operator-provided strings and escape HCL template markers.
function ConvertTo-HclString {
    param([string]$Value)
    $Value.Replace('${', '$${').Replace('%{', '%%{') | ConvertTo-Json -Compress
}

$tfvarsContent = @"
project_id = $(ConvertTo-HclString $PROJECT_ID)
region     = $(ConvertTo-HclString $REGION)
zone       = $(ConvertTo-HclString $ZONE)
github_repo_owner = $(ConvertTo-HclString $GITHUB_REPO_OWNER)
github_repo_name  = $(ConvertTo-HclString $GITHUB_REPO_NAME)
github_branch     = $(ConvertTo-HclString $GITHUB_BRANCH)
github_webhook_secret = $(ConvertTo-HclString $WEBHOOK_SECRET_PLAIN)
webhook_api_key = $(ConvertTo-HclString $WEBHOOK_API_KEY_PLAIN)
github_pat = $(ConvertTo-HclString $GITHUB_TOKEN_PLAIN)
"@

$tfvarsContent | Out-File -FilePath "terraform.tfvars" -Encoding UTF8

# Generated immutable templates replace automatically through Terraform.
# Never delete the current template before create_before_destroy replacement.

# Plan Terraform deployment
Write-Host "Planning Terraform deployment..." -ForegroundColor $Yellow
& terraform plan
if ($LASTEXITCODE -ne 0) {
    Write-Host "✗ Error planning Terraform deployment" -ForegroundColor $Red
    exit 1
}

# Ask for confirmation
Write-Host "Review the Terraform plan above." -ForegroundColor $Yellow
$apply = Read-Host "Do you want to apply these changes? (y/N)"
if ($apply -ne "y" -and $apply -ne "Y") {
    Write-Host "Deployment cancelled." -ForegroundColor $Yellow
    exit 0
}

# Apply Terraform
Write-Host "Applying Terraform configuration..." -ForegroundColor $Yellow
& terraform apply -auto-approve
if ($LASTEXITCODE -ne 0) {
    Write-Host "✗ Error applying Terraform configuration" -ForegroundColor $Red
    exit 1
}

# After successful apply, set force_recreate_template = false in terraform.tfvars
$tfvarsPath = Join-Path $terraformDir "terraform.tfvars"
if (Test-Path $tfvarsPath) {
    $tfvarsLines = Get-Content $tfvarsPath
    $updatedLines = @()
    $found = $false
    foreach ($line in $tfvarsLines) {
        if ($line -match '^\s*force_recreate_template\s*=') {
            $updatedLines += 'force_recreate_template = false'
            $found = $true
        }
        else {
            $updatedLines += $line
        }
    }
    if (-not $found) {
        $updatedLines += 'force_recreate_template = false'
    }
    $updatedLines | Set-Content -Encoding UTF8 $tfvarsPath
    Write-Host "force_recreate_template set to false in terraform.tfvars" -ForegroundColor $Yellow
}

# Update GitHub token in Secret Manager after deployment
Write-Host "Updating GitHub token in Secret Manager..." -ForegroundColor $Yellow
Write-Output $GITHUB_TOKEN_PLAIN | & gcloud secrets versions add github-runner-token --data-file=-
if ($LASTEXITCODE -ne 0) {
    Write-Host "⚠ Warning: Failed to update GitHub token in Secret Manager" -ForegroundColor $Yellow
    Write-Host "You may need to manually update the secret with: gcloud secrets versions add github-runner-token --data-file=-" -ForegroundColor $Yellow
}
else {
    Write-Host "✓ GitHub token updated in Secret Manager" -ForegroundColor $Green
}

# Get outputs
Write-Host "Deployment completed successfully!" -ForegroundColor $Green
Write-Host ""
Write-Host "Infrastructure Details:" -ForegroundColor $Yellow
$triggerName = & terraform output -raw webhook_trigger_name
$webhookUrl = & terraform output -raw webhook_url
& terraform output project_id
& terraform output region  
Write-Host "webhook_trigger_name = `"$triggerName`""
Write-Host "Use the sensitive webhook_url Terraform output locally; credentials are hidden."

Write-Host ""
Write-Host "⚠️  IMPORTANT: Complete Webhook URL Required" -ForegroundColor $Red
Write-Host "The webhook URL needs both API key AND secret parameters." -ForegroundColor $Yellow
Write-Host "1. Go to: https://console.cloud.google.com/cloud-build/triggers" -ForegroundColor $Yellow
Write-Host "2. Click on: $triggerName" -ForegroundColor $Yellow
Write-Host "3. Copy the 'Webhook URL' (includes ?key=... parameter)" -ForegroundColor $Yellow
Write-Host "4. The complete URL should be:" -ForegroundColor $Yellow
Write-Host "Use the sensitive webhook_url Terraform output locally; credentials are hidden."
Write-Host ""
Write-Host "Example format:" -ForegroundColor $Yellow
Write-Host "Use the sensitive webhook_url Terraform output locally; credentials are hidden."

# Setup GitHub webhook if GitHub CLI is available
try {
    $null = Get-Command gh -ErrorAction Stop
    Write-Host ""
    Write-Host "Setting up GitHub webhook..." -ForegroundColor $Yellow
    
    # Check if authenticated with GitHub
    try {
        & gh auth status --hostname github.com 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "✓ GitHub CLI authenticated" -ForegroundColor $Green
            Write-Host ""
            Write-Host "⚠️  Complete Webhook URL Required" -ForegroundColor $Red
            Write-Host "You need to get the API key from console and add the secret parameter:" -ForegroundColor $Yellow
Write-Host "Use the sensitive webhook_url Terraform output locally; credentials are hidden."
            Write-Host ""
            $userChoice = Read-Host "Do you have the complete webhook URL from Google Cloud Console? (y/N)"
            if ($userChoice -eq "y" -or $userChoice -eq "Y") {
                $completeWebhookUrl = Read-Host "Enter the complete webhook URL (with API key and secret)"
                
                if ($completeWebhookUrl -and $completeWebhookUrl.Contains("key=") -and $completeWebhookUrl.Contains("secret=")) {
                    Write-Host "🔗 Setting up GitHub webhook for $GITHUB_REPO_OWNER/$GITHUB_REPO_NAME..." -ForegroundColor $Yellow
                    
                    # Check if webhook already exists
                    $existingWebhooks = & gh api "repos/$GITHUB_REPO_OWNER/$GITHUB_REPO_NAME/hooks" | ConvertFrom-Json
                    $existingWebhook = $existingWebhooks | Where-Object { $_.config.url -like "*$($triggerName)*" -or $_.config.url -like "*workflow_job*" }
                    
                    if ($existingWebhook) {
                        Write-Host "📝 Updating existing webhook (ID: $($existingWebhook.id))..." -ForegroundColor $Yellow
                        
                        & gh api --method PATCH "repos/$GITHUB_REPO_OWNER/$GITHUB_REPO_NAME/hooks/$($existingWebhook.id)" `
                            --field name="web" `
                            --field active=true `
                            --field "config[url]=$completeWebhookUrl" `
                            --field "config[content_type]=json" `
                            --field "config[insecure_ssl]=0" `
                            --field events[]="workflow_job"
                        
                        Write-Host "✅ Webhook updated successfully!" -ForegroundColor $Green
                        Write-Host "� Webhook ID: $($existingWebhook.id)" -ForegroundColor $Green
                    }
                    else {
                        Write-Host "🆕 Creating new webhook..." -ForegroundColor $Yellow
                        
                        $newWebhook = & gh api --method POST "repos/$GITHUB_REPO_OWNER/$GITHUB_REPO_NAME/hooks" `
                            --field name="web" `
                            --field active=true `
                            --field "config[url]=$completeWebhookUrl" `
                            --field "config[content_type]=json" `
                            --field "config[insecure_ssl]=0" `
                            --field events[]="workflow_job" | ConvertFrom-Json
                        
                        Write-Host "✅ Webhook created successfully!" -ForegroundColor $Green
                        Write-Host "📋 Webhook ID: $($newWebhook.id)" -ForegroundColor $Green
                    }
                    
                    # Test webhook
                    Write-Host "🧪 Testing webhook..." -ForegroundColor $Yellow
                    $hooks = & gh api "repos/$GITHUB_REPO_OWNER/$GITHUB_REPO_NAME/hooks" | ConvertFrom-Json
                    $targetHook = $hooks | Where-Object { $_.config.url -eq $completeWebhookUrl } | Select-Object -First 1
                    if ($targetHook) {
                        & gh api --method POST "repos/$GITHUB_REPO_OWNER/$GITHUB_REPO_NAME/hooks/$($targetHook.id)/tests"
                        Write-Host "✅ Webhook test sent!" -ForegroundColor $Green
                    }
                    
                    Write-Host "🎉 GitHub webhook setup complete!" -ForegroundColor $Green
                }
                else {
                    Write-Host "❌ Invalid URL format. URL must contain both 'key=' and 'secret=' parameters." -ForegroundColor $Red
                    Write-Host "You can set it up manually later." -ForegroundColor $Yellow                
                }
            }
            else {
                Write-Host "Skipping webhook creation. You can set it up manually later." -ForegroundColor $Yellow
            }
        }
        else {
            Write-Host "⚠ GitHub CLI not authenticated. Run 'gh auth login' to set up webhook automatically." -ForegroundColor $Yellow
            Write-Host "Or manually configure webhook with the complete URL from Google Cloud Console." -ForegroundColor $Yellow
        }
    }
    catch {
        Write-Host "⚠ GitHub CLI authentication required. Run 'gh auth login' to set up webhook automatically." -ForegroundColor $Yellow
        Write-Host "Or manually configure webhook with the complete URL from Google Cloud Console." -ForegroundColor $Yellow
    }
}
catch {
    Write-Host "⚠ GitHub CLI not available. Please set up webhook manually:" -ForegroundColor $Yellow
    Write-Host "   1. Get complete webhook URL from Google Cloud Console (with API key)" -ForegroundColor $Yellow
    Write-Host "   2. Create webhook with:" -ForegroundColor $Yellow
    Write-Host "      - URL: [Complete URL from console]" -ForegroundColor $Yellow
Write-Host "Use the sensitive webhook_url Terraform output locally; credentials are hidden."
    Write-Host "      - Events: workflow_job" -ForegroundColor $Yellow
    Write-Host "      - Content Type: application/json" -ForegroundColor $Yellow
}

Write-Host ""
Write-Host "🎯 Setup completed successfully!" -ForegroundColor $Green
Write-Host ""
Write-Host "Your GitHub Actions self-hosted runner infrastructure is ready!" -ForegroundColor $Yellow
Write-Host "- Infrastructure deployed and configured" -ForegroundColor $Green
Write-Host "- Webhook configured and ready to receive events" -ForegroundColor $Green
Write-Host "- Cleanup runs every 2 hours to remove old instances" -ForegroundColor $Green
Write-Host ""
Write-Host "To test the setup:" -ForegroundColor $Yellow
Write-Host "1. Create a workflow in your repository with 'runs-on: self-hosted'" -ForegroundColor $Yellow
Write-Host "2. Push the workflow to trigger a job" -ForegroundColor $Yellow
Write-Host "3. Check GCP Console > Compute Engine for runner instances" -ForegroundColor $Yellow
