#!/usr/bin/env powershell
<#
.SYNOPSIS
    Wrapper script for GitHub runner cleanup using token from terraform.tfvars

.DESCRIPTION
    This script reads the GitHub token from terraform.tfvars and calls the generic cleanup script.
    Useful for quick cleanup of your infrastructure repositories.

.PARAMETER RepoName
    GitHub repository name (defaults to "VeraID")

.PARAMETER DryRun
    Show what would be deleted without actually deleting

.PARAMETER RemoveAll
    Remove ALL runners including online/busy ones (use with caution!)

.EXAMPLE
    # Clean VeraID repository (dry run)
    .\quick-cleanup.ps1 -DryRun

.EXAMPLE
    # Clean different repository
    .\quick-cleanup.ps1 -RepoName "PARITY_INPUT_115"

.EXAMPLE
    # Remove all runners from VeraID
    .\quick-cleanup.ps1 -RemoveAll
#>

param(
    [string]$RepoName = "VeraID",
    [switch]$DryRun = $false,
    [switch]$RemoveAll = $false
)

$ErrorActionPreference = 'Stop'

# Get the directory of this script
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Path to terraform.tfvars
$tfvarsPath = Join-Path $scriptDir "terraform\terraform.tfvars"

if (-not (Test-Path $tfvarsPath)) {
    Write-Host "Error: terraform.tfvars not found at: $tfvarsPath" -ForegroundColor Red
    Write-Host "Please ensure you're running this script from the repository root." -ForegroundColor Yellow
    exit 1
}

try {
    # Read GitHub token from terraform.tfvars
    Write-Host "Reading GitHub token from terraform.tfvars..." -ForegroundColor Blue
    $tfvarsContent = Get-Content $tfvarsPath
    $tokenLine = $tfvarsContent | Where-Object { $_ -match '^github_token\s*=' }
    
    if (-not $tokenLine) {
        Write-Host "Error: github_token not found in terraform.tfvars" -ForegroundColor Red
        exit 1
    }
    
    # Extract token value (handle quotes)
    $token = ($tokenLine -split '=', 2)[1].Trim().Trim('"').Trim("'")
    
    if (-not $token) {
        Write-Host "Error: github_token is empty in terraform.tfvars" -ForegroundColor Red
        exit 1
    }
    
    Write-Host "GitHub token loaded successfully" -ForegroundColor Green
    
    # Read repo owner from terraform.tfvars
    $ownerLine = $tfvarsContent | Where-Object { $_ -match '^github_repo_owner\s*=' }
    $repoOwner = if ($ownerLine) { 
        ($ownerLine -split '=', 2)[1].Trim().Trim('"').Trim("'")
    }
    else { 
        "PARITY_INPUT_010" 
    }
    
    Write-Host "Repository: $repoOwner/$RepoName" -ForegroundColor Cyan
    
    # Call the main cleanup script
    $cleanupScript = Join-Path $scriptDir "cleanup-github-runners.ps1"
    
    if (-not (Test-Path $cleanupScript)) {
        Write-Host "Error: cleanup-github-runners.ps1 not found at: $cleanupScript" -ForegroundColor Red
        exit 1
    }
    
    $params = @{
        RepoOwner   = $repoOwner
        RepoName    = $RepoName
        GitHubToken = $token
    }
    
    if ($DryRun) { $params.DryRun = $true }
    if ($RemoveAll) { $params.RemoveAll = $true }
    
    & $cleanupScript @params
    
}
catch {
    Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
