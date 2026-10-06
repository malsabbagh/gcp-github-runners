# GitHub Webhook Setup Script (PowerShell)
# This script helps configure GitHub webhooks for automatic runner deployment

$ErrorActionPreference = "Stop"

# Colors for output
$Red = "Red"
$Green = "Green"
$Yellow = "Yellow"
$Blue = "Blue"

Write-Host "GitHub Webhook Setup for Runner Auto-Deployment" -ForegroundColor $Green
Write-Host "=================================================="

# Check if required tools are installed
function Test-Prerequisites {
    Write-Host "Checking prerequisites..." -ForegroundColor $Yellow
    
    try {
        $null = Get-Command gcloud -ErrorAction Stop
        Write-Host "✓ gcloud CLI found" -ForegroundColor $Green
    }
    catch {
        Write-Host "✗ Error: gcloud CLI is not installed" -ForegroundColor $Red
        exit 1
    }
    
    try {
        $null = Get-Command gh -ErrorAction Stop
        Write-Host "✓ GitHub CLI found" -ForegroundColor $Green
        return $false  # Manual setup not needed
    }
    catch {
        Write-Host "⚠ Warning: GitHub CLI (gh) is not installed" -ForegroundColor $Yellow
        Write-Host "You'll need to configure the webhook manually via GitHub web interface" -ForegroundColor $Yellow
        return $true   # Manual setup needed
    }
}

# Get webhook URL from Cloud Build trigger
function Get-WebhookUrl {
    $terraformDir = Join-Path $PSScriptRoot "../terraform"
    $webhookUrl = & terraform "-chdir=$terraformDir" output -raw webhook_url
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($webhookUrl)) {
        throw "Configure webhook_api_key and github_webhook_secret before webhook setup."
    }
    return $webhookUrl
}

# Configure GitHub webhook manually
function Show-ManualSetup {
    param($WebhookUrl, $RepoOwner, $RepoName)
    
    Write-Host "Manual Setup Required:" -ForegroundColor $Yellow
    Write-Host "1. Go to: https://github.com/$RepoOwner/$RepoName/settings/hooks"
    Write-Host "2. Click 'Add webhook'"
    Write-Host "3. Use these settings:"
    Write-Host "   - Payload URL: use the sensitive webhook_url Terraform output locally"
    Write-Host "   - Content type: application/json"
    Write-Host "   - Secret: [your webhook secret]"
    Write-Host "   - Events: Workflow jobs"
    Write-Host "4. Click 'Add webhook'"
}

# Configure GitHub webhook using GitHub CLI
function Set-GitHubWebhook {
    param($WebhookUrl, $RepoOwner, $RepoName, $WebhookSecret)
    
    # Check if user is authenticated with GitHub CLI
    try {
        & gh auth status 2>$null
        if ($LASTEXITCODE -ne 0) { throw "GitHub CLI authentication failed" }
    }
    catch {
        Write-Host "Please authenticate with GitHub CLI first:" -ForegroundColor $Yellow
        Write-Host "gh auth login"
        exit 1
    }
    
    # Create the webhook using GitHub CLI
    Write-Host "Creating webhook..." -ForegroundColor $Yellow
    
    $webhookConfig = @{
        name   = "web"
        active = $true
        events = @("workflow_job")
        config = @{
            url          = $WebhookUrl
            content_type = "json"
            secret       = $WebhookSecret
            insecure_ssl = "0"
        }
    } | ConvertTo-Json -Depth 3
    
    try {
        $webhookConfig | & gh api "repos/$RepoOwner/$RepoName/hooks" --method POST --input - | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "GitHub webhook creation failed" }
        Write-Host "✓ Webhook created successfully!" -ForegroundColor $Green
    }
    catch {
        Write-Host "✗ Failed to create webhook" -ForegroundColor $Red
        Write-Host "Please check your repository permissions and try manual setup" -ForegroundColor $Yellow
        throw
    }
}

# Test the webhook
function Test-Webhook {
    param($RepoOwner, $RepoName)
    
    Write-Host "Testing webhook setup..." -ForegroundColor $Yellow
    
    $test = Read-Host "Would you like to test the webhook by creating a test PR? (y/N)"
    
    if ($test -eq "y" -or $test -eq "Y") {
        Write-Host "Creating test branch and PR..." -ForegroundColor $Yellow
        
        $gitRoot = & git rev-parse --show-toplevel
        if ($LASTEXITCODE -ne 0) { throw "A target Git repository is required." }
        Push-Location $gitRoot
        try {
        # Create a test branch
        $testBranch = "test-webhook-$(Get-Date -Format 'yyyyMMddHHmmss')"
        & git checkout -b $testBranch
        
        # Make a small change
        "# Test Webhook - $(Get-Date)" | Out-File -FilePath "test-webhook.md" -Encoding UTF8
        & git add test-webhook.md
        & git commit -m "Test webhook trigger for runner deployment"
        & git push origin $testBranch
        
        # Create PR
        & gh pr create --title "Test Webhook Integration" --body "This PR tests the webhook integration for automatic runner deployment. This can be closed after testing."
        
        } finally { Pop-Location }
        Write-Host "✓ Test PR created!" -ForegroundColor $Green
        Write-Host "Check Cloud Build logs to see if the runner was created:"
        Write-Host "  gcloud builds list --limit 5"
        Write-Host "  gcloud compute instances list --filter='labels.purpose=github-runner'"
    }
}

# Main execution
try {
    $manualSetup = Test-Prerequisites
    $webhookUrl = Get-WebhookUrl
    
    # Get repository information
    $repoOwner = Read-Host "GitHub repository owner/organization"
    if ([string]::IsNullOrWhiteSpace($repoOwner)) {
        Write-Host "Repository owner is required" -ForegroundColor $Red
        exit 1
    }
    
    $repoName = Read-Host "GitHub repository name"
    if ([string]::IsNullOrWhiteSpace($repoName)) {
        Write-Host "Repository name is required" -ForegroundColor $Red
        exit 1
    }
    
    $webhookSecret = Read-Host "Webhook secret (from terraform.tfvars)" -AsSecureString
    $webhookSecretPlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($webhookSecret))
    
    if ($manualSetup) {
        Show-ManualSetup -WebhookUrl $webhookUrl -RepoOwner $repoOwner -RepoName $repoName
    }
    else {
        Set-GitHubWebhook -WebhookUrl $webhookUrl -RepoOwner $repoOwner -RepoName $repoName -WebhookSecret $webhookSecretPlain
    }
    
    Write-Host ""
    Write-Host "Webhook setup completed!" -ForegroundColor $Green
    Write-Host ""
    Write-Host "Your repository is now configured to automatically deploy runners for:"
    Write-Host "  - Workflow job events (queued)"
    Write-Host ""
    
    Test-Webhook -RepoOwner $repoOwner -RepoName $repoName
    
    Write-Host ""
    Write-Host "Monitoring Commands:" -ForegroundColor $Blue
    Write-Host "  # Check recent builds"
    Write-Host "  gcloud builds list --limit 10"
    Write-Host ""
    Write-Host "  # Check active runners"
    Write-Host "  gcloud compute instances list --filter='labels.purpose=github-runner'"
    Write-Host ""
    Write-Host "  # View webhook deliveries in GitHub"
    Write-Host "  https://github.com/$repoOwner/$repoName/settings/hooks"
}
catch {
    Write-Host "Setup failed: $($_.Exception.Message)" -ForegroundColor $Red
    exit 1
}
