#!/usr/bin/env powershell
<#
.SYNOPSIS
    Generic GitHub Runner Cleanup Script - Removes offline or all runners from any GitHub repository

.DESCRIPTION
    This script connects to the GitHub API to list and remove runners from a specified repository.
    By default, it only removes offline runners, but can be configured to remove all runners.

.PARAMETER RepoOwner
    GitHub repository owner/organization name (required)

.PARAMETER RepoName
    GitHub repository name (required)

.PARAMETER GitHubToken
    GitHub Personal Access Token with 'repo' scope. If not provided, you'll be prompted to enter it.

.PARAMETER DryRun
    Show what would be deleted without actually deleting anything

.PARAMETER RemoveAll
    Remove ALL runners (including online and busy ones). Use with caution!

.EXAMPLE
    # Dry run for VeraID repository
    .\cleanup-github-runners.ps1 -RepoOwner "PARITY_INPUT_010" -RepoName "VeraID" -DryRun

.EXAMPLE
    # Remove offline runners only
    .\cleanup-github-runners.ps1 -RepoOwner "PARITY_INPUT_010" -RepoName "VeraID" -GitHubToken "your_token"

.EXAMPLE
    # Remove ALL runners (dangerous!)
    .\cleanup-github-runners.ps1 -RepoOwner "PARITY_INPUT_010" -RepoName "VeraID" -GitHubToken "your_token" -RemoveAll

.NOTES
    Requires GitHub Personal Access Token with 'repo' scope.
    Create one at: https://github.com/settings/tokens
#>

param(
    [Parameter(Mandatory = $true, HelpMessage = "GitHub repository owner/organization name")]
    [string]$RepoOwner,
    
    [Parameter(Mandatory = $true, HelpMessage = "GitHub repository name")]
    [string]$RepoName,
    
    [Parameter(HelpMessage = "GitHub Personal Access Token with 'repo' scope")]
    [string]$GitHubToken = "",
    
    [Parameter(HelpMessage = "Show what would be deleted without actually deleting")]
    [switch]$DryRun = $false,
    
    [Parameter(HelpMessage = "Remove ALL runners including online/busy ones (use with caution!)")]
    [switch]$RemoveAll = $false
)

$ErrorActionPreference = 'Stop'

Write-Host "GitHub Runner Cleanup Script" -ForegroundColor Yellow
Write-Host "Repository: $RepoOwner/$RepoName" -ForegroundColor Cyan
Write-Host "=" * 50

# Get GitHub token
if (-not $GitHubToken) {
    Write-Host "GitHub token not provided via parameter." -ForegroundColor Yellow
    Write-Host "Please provide your GitHub Personal Access Token with 'repo' scope." -ForegroundColor Yellow
    Write-Host "You can create one at: https://github.com/settings/tokens" -ForegroundColor Cyan
    Write-Host ""
    $secureToken = Read-Host "Enter your GitHub token (input will be hidden)" -AsSecureString
    $GitHubToken = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto([System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken))
}

if (-not $GitHubToken) {
    Write-Host "Error: GitHub token is required" -ForegroundColor Red
    exit 1
}

try {
    # Setup GitHub API
    $baseUri = "https://api.github.com/repos/$RepoOwner/$RepoName/actions/runners"
    $headers = @{ 
        'Authorization'        = "Bearer $GitHubToken"
        'Accept'               = 'application/vnd.github+json'
        'X-GitHub-Api-Version' = '2022-11-28'
        'User-Agent'           = 'github-runner-cleanup'
    }

    # Test API access
    Write-Host "Testing GitHub API access..." -ForegroundColor Blue
    try {
        $testUri = "https://api.github.com/repos/$RepoOwner/$RepoName"
        $repoInfo = Invoke-RestMethod -Method Get -Headers $headers -Uri $testUri
        Write-Host "Successfully connected to repository: $($repoInfo.full_name)" -ForegroundColor Green
    }
    catch {
        Write-Host "Error: Cannot access repository $RepoOwner/$RepoName" -ForegroundColor Red
        Write-Host "Please check your token permissions and repository access." -ForegroundColor Red
        Write-Host "Error details: $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }

    # Get all runners
    Write-Host "Fetching runners from $RepoOwner/$RepoName..." -ForegroundColor Blue
    $allRunners = @()
    $page = 1
    
    do {
        $uri = "$baseUri" + "?per_page=100&page=$page"
        Write-Host "  Fetching page $page..." -ForegroundColor Gray
        
        try {
            $response = Invoke-RestMethod -Method Get -Headers $headers -Uri $uri
            if ($response.runners) {
                $allRunners += $response.runners
                $hasMore = $response.runners.Count -eq 100
            }
            else {
                $hasMore = $false
            }
        }
        catch {
            Write-Host "Error fetching runners: $($_.Exception.Message)" -ForegroundColor Red
            exit 1
        }
        
        $page++
    } while ($hasMore)

    Write-Host "Total runners found: $($allRunners.Count)" -ForegroundColor Blue

    if ($allRunners.Count -eq 0) {
        Write-Host "No runners found. Repository is clean!" -ForegroundColor Green
        exit 0
    }

    # Categorize runners
    $offlineRunners = @($allRunners | Where-Object { $_.status -eq 'offline' })
    $onlineRunners = @($allRunners | Where-Object { $_.status -eq 'online' })
    $busyRunners = @($allRunners | Where-Object { $_.status -eq 'busy' })

    Write-Host ""
    Write-Host "Runner Status Summary:" -ForegroundColor Yellow
    Write-Host "  Offline: $($offlineRunners.Count)"
    Write-Host "  Online:  $($onlineRunners.Count)"  
    Write-Host "  Busy:    $($busyRunners.Count)"
    Write-Host ""

    # Show all runners with details
    Write-Host "Detailed Runner List:" -ForegroundColor Yellow
    foreach ($runner in $allRunners) {
        $status = $runner.status.ToUpper()
        $statusColor = switch ($runner.status) {
            'offline' { 'Red' }
            'online' { 'Green' }
            'busy' { 'Yellow' }
            default { 'White' }
        }
        
        $lastSeen = if ($runner.last_seen_at) { 
            try {
                $date = [DateTime]::Parse($runner.last_seen_at)
                $date.ToString("yyyy-MM-dd HH:mm:ss UTC")
            }
            catch {
                $runner.last_seen_at
            }
        }
        else { 
            "Never" 
        }
        
        $osInfo = if ($runner.os) { " [$($runner.os)]" } else { "" }
        
        Write-Host "  [$status]" -ForegroundColor $statusColor -NoNewline
        Write-Host " $($runner.name) (ID: $($runner.id))$osInfo"
        Write-Host "         Last seen: $lastSeen" -ForegroundColor Gray
        
        if ($runner.labels -and $runner.labels.Count -gt 0) {
            $labelStr = ($runner.labels | ForEach-Object { $_.name }) -join ', '
            Write-Host "         Labels: $labelStr" -ForegroundColor Gray
        }
        Write-Host ""
    }

    # Determine which runners to remove
    $runnersToRemove = @()
    if ($RemoveAll) {
        $runnersToRemove = $allRunners
        Write-Host "REMOVE ALL MODE: All $($allRunners.Count) runners will be deleted!" -ForegroundColor Red
    }
    else {
        $runnersToRemove = $offlineRunners
        if ($offlineRunners.Count -eq 0) {
            Write-Host "No offline runners to clean up!" -ForegroundColor Green
            Write-Host "Use -RemoveAll flag to delete all runners (including online/busy ones)" -ForegroundColor Yellow
            exit 0
        }
        Write-Host "Found $($offlineRunners.Count) offline runners to remove:" -ForegroundColor Yellow
    }

    foreach ($runner in $runnersToRemove) {
        $statusColor = switch ($runner.status) {
            'offline' { 'Red' }
            'online' { 'Green' }
            'busy' { 'Yellow' }
            default { 'White' }
        }
        Write-Host "  - [$($runner.status.ToUpper())] $($runner.name) (ID: $($runner.id))" -ForegroundColor $statusColor
    }
    Write-Host ""

    if ($DryRun) {
        $actionText = if ($RemoveAll) { "delete ALL $($runnersToRemove.Count) runners" } else { "delete $($runnersToRemove.Count) offline runners" }
        Write-Host "DRY RUN: Would $actionText" -ForegroundColor Magenta
        Write-Host "Run without -DryRun to actually delete these runners." -ForegroundColor Yellow
        exit 0
    }

    # Confirm deletion
    $actionText = if ($RemoveAll) { "ALL $($runnersToRemove.Count) runners (including online/busy)" } else { "$($runnersToRemove.Count) offline runners" }
    Write-Host "WARNING: You are about to delete $actionText!" -ForegroundColor Red
    $confirm = Read-Host "Type 'DELETE' to confirm"
    if ($confirm -ne 'DELETE') {
        Write-Host "Operation cancelled." -ForegroundColor Yellow
        exit 0
    }

    Write-Host "Deleting $($runnersToRemove.Count) runners..." -ForegroundColor Red
    $deleted = 0
    $failed = 0

    foreach ($runner in $runnersToRemove) {
        $runnerId = $runner.id
        $runnerName = $runner.name
        
        Write-Host "  Deleting: $runnerName (ID: $runnerId)..." -ForegroundColor Red -NoNewline
        
        try {
            $deleteUri = "$baseUri/$runnerId"
            $response = Invoke-WebRequest -Method Delete -Headers $headers -Uri $deleteUri
            
            if ($response.StatusCode -eq 204) {
                Write-Host " SUCCESS" -ForegroundColor Green
                $deleted++
            }
            else {
                Write-Host " UNEXPECTED RESPONSE ($($response.StatusCode))" -ForegroundColor Yellow
                $failed++
            }
        }
        catch {
            $statusCode = "Unknown"
            try { 
                $statusCode = [int]$_.Exception.Response.StatusCode 
            }
            catch { }
            
            if ($statusCode -eq 204) {
                Write-Host " SUCCESS" -ForegroundColor Green
                $deleted++
            }
            else {
                Write-Host " FAILED (HTTP $statusCode)" -ForegroundColor Red
                $failed++
            }
        }
        
        Start-Sleep -Milliseconds 500  # Rate limiting
    }

    Write-Host ""
    Write-Host "Cleanup Summary:" -ForegroundColor Yellow
    Write-Host "  Successfully deleted: $deleted runners"
    Write-Host "  Failed to delete: $failed runners"
    Write-Host "  Total processed: $($deleted + $failed) runners"

    if ($failed -eq 0) {
        Write-Host ""
        $successMsg = if ($RemoveAll) { "All runners cleaned up successfully!" } else { "All offline runners cleaned up successfully!" }
        Write-Host $successMsg -ForegroundColor Green
    }
    else {
        Write-Host ""
        Write-Host "Some runners could not be deleted. This may be normal if they were already removed." -ForegroundColor Yellow
    }

}
catch {
    Write-Host "Unexpected error: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "GitHub runner cleanup completed!" -ForegroundColor Green
Write-Host "You can verify the cleanup at: https://github.com/$RepoOwner/$RepoName/settings/actions/runners" -ForegroundColor Cyan
