# PowerShell script to automatically register GitHub webhook

param(
    [string]$RepoOwner = "PARITY_INPUT_010",
    [string]$RepoName = "VeraID",
    [string]$WebhookUrl = "https://cloudbuild.googleapis.com/v1/projects/PARITY_INPUT_064/triggers/github-runner-webhook:webhook",
    [string]$WebhookSecret = "PARITY_INPUT_348"
)

Write-Host "🔗 Registering GitHub webhook for $RepoOwner/$RepoName..." -ForegroundColor Cyan

# Check if GitHub CLI is installed
if (!(Get-Command gh -ErrorAction SilentlyContinue)) {
    Write-Error "GitHub CLI (gh) is not installed. Please install it first: https://cli.github.com/"
    exit 1
}

# Check if authenticated
try {
    gh auth status --hostname github.com 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Not authenticated with GitHub. Run 'gh auth login' first."
        exit 1
    }
}
catch {
    Write-Error "GitHub CLI authentication required. Run 'gh auth login' first."
    exit 1
}

# Check if webhook already exists
Write-Host "📋 Checking for existing webhooks..." -ForegroundColor Yellow
$existingWebhooks = gh api "repos/$RepoOwner/$RepoName/hooks" | ConvertFrom-Json
$existingWebhook = $existingWebhooks | Where-Object { $_.config.url -eq $WebhookUrl }

if ($existingWebhook) {
    Write-Host "📝 Updating existing webhook (ID: $($existingWebhook.id))..." -ForegroundColor Yellow
    
    gh api --method PATCH "repos/$RepoOwner/$RepoName/hooks/$($existingWebhook.id)" `
        --field name="web" `
        --field active=true `
        --field config[url]="$WebhookUrl" `
        --field config[content_type]="json" `
        --field config[secret]="$WebhookSecret" `
        --field config[insecure_ssl]="0" `
        --field events[]="workflow_job" `
        --field events[]="pull_request"
    
    Write-Host "✅ Webhook updated successfully!" -ForegroundColor Green
}
else {
    Write-Host "🆕 Creating new webhook..." -ForegroundColor Yellow
    
    gh api --method POST "repos/$RepoOwner/$RepoName/hooks" `
        --field name="web" `
        --field active=true `
        --field config[url]="$WebhookUrl" `
        --field config[content_type]="json" `
        --field config[secret]="$WebhookSecret" `
        --field config[insecure_ssl]="0" `
        --field events[]="workflow_job" `
        --field events[]="pull_request"
    
    Write-Host "✅ Webhook created successfully!" -ForegroundColor Green
}

Write-Host "🧪 Testing webhook..." -ForegroundColor Cyan
$hooks = gh api "repos/$RepoOwner/$RepoName/hooks" | ConvertFrom-Json
$targetHook = $hooks | Where-Object { $_.config.url -eq $WebhookUrl } | Select-Object -First 1
if ($targetHook) {
    gh api --method POST "repos/$RepoOwner/$RepoName/hooks/$($targetHook.id)/tests"
    Write-Host "✅ Webhook test sent!" -ForegroundColor Green
}

Write-Host "🎉 GitHub webhook setup complete!" -ForegroundColor Green
