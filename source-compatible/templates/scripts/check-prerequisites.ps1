# Prerequisite Checker for GitHub Runner Infrastructure
# Run this script first to check if all requirements are met

$ErrorActionPreference = "Stop"

Write-Host "GitHub Runner Infrastructure - Prerequisite Checker" -ForegroundColor Cyan
Write-Host "====================================================="
Write-Host ""

$allGood = $true

# Check PowerShell version
Write-Host "Checking PowerShell version..." -ForegroundColor Yellow
$psVersion = $PSVersionTable.PSVersion
Write-Host "PowerShell version: $psVersion" -ForegroundColor Green
if ($psVersion.Major -lt 5) {
    Write-Host "⚠ Warning: PowerShell 5.1 or later is recommended" -ForegroundColor Yellow
}

# Check for gcloud CLI
Write-Host "Checking for Google Cloud CLI..." -ForegroundColor Yellow
try {
    $gcloudVersion = & gcloud version --format="value(Google Cloud SDK)" 2>$null
    Write-Host "✓ gcloud CLI found: $gcloudVersion" -ForegroundColor Green
}
catch {
    Write-Host "✗ gcloud CLI not found" -ForegroundColor Red
    Write-Host "  Install from: https://cloud.google.com/sdk/docs/install-sdk#windows" -ForegroundColor Yellow
    Write-Host "  Or use Chocolatey: choco install gcloudsdk" -ForegroundColor Yellow
    $allGood = $false
}

# Check for Terraform
Write-Host "Checking for Terraform..." -ForegroundColor Yellow
try {
    $terraformVersion = & terraform version -json 2>$null | ConvertFrom-Json
    Write-Host "✓ Terraform found: $($terraformVersion.terraform_version)" -ForegroundColor Green
}
catch {
    Write-Host "✗ Terraform not found" -ForegroundColor Red
    Write-Host "  Install from: https://developer.hashicorp.com/terraform/downloads" -ForegroundColor Yellow
    Write-Host "  Or use Chocolatey: choco install terraform" -ForegroundColor Yellow
    $allGood = $false
}

# Check for Git (optional but recommended)
Write-Host "Checking for Git..." -ForegroundColor Yellow
try {
    $gitVersion = & git --version 2>$null
    Write-Host "✓ Git found: $gitVersion" -ForegroundColor Green
}
catch {
    Write-Host "⚠ Git not found (optional but recommended)" -ForegroundColor Yellow
    Write-Host "  Install from: https://git-scm.com/downloads" -ForegroundColor Yellow
}

# Check if running as administrator (not required but helpful for some operations)
Write-Host "Checking privileges..." -ForegroundColor Yellow
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")
if ($isAdmin) {
    Write-Host "✓ Running as Administrator" -ForegroundColor Green
}
else {
    Write-Host "⚠ Not running as Administrator (may be needed for some operations)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Summary:" -ForegroundColor Cyan
Write-Host "--------"

if ($allGood) {
    Write-Host "✓ All prerequisites are met! You can run the setup script." -ForegroundColor Green
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor Yellow
    Write-Host "1. Run: .\setup.ps1 (PowerShell version)"
    Write-Host "2. Or run: bash setup.sh (if you prefer bash)"
}
else {
    Write-Host "✗ Some prerequisites are missing. Please install them first." -ForegroundColor Red
    Write-Host ""
    Write-Host "Quick install with Chocolatey (if you have it):" -ForegroundColor Yellow
    Write-Host "  choco install gcloudsdk terraform git"
}

Write-Host ""
