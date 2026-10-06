#!/usr/bin/env pwsh

param(
    [Parameter(Mandatory = $false)]
    [string]$ProjectId = "",
    
    [Parameter(Mandatory = $false)]
    [string]$TopicName = "hybrid-cleanup-events",
    
    [Parameter(Mandatory = $false)]
    [string[]]$RunnerNames = @(),
    
    [Parameter(Mandatory = $false)]
    [string[]]$InstanceNames = @(),
    
    [Parameter(Mandatory = $false)]
    [switch]$CleanupAll,
    
    [Parameter(Mandatory = $false)]
    [switch]$CleanupStale,
    
    [Parameter(Mandatory = $false)]
    [string]$TriggerType = "manual"
)

Write-Host "🧹 GitHub Runner Hybrid Cleanup Trigger" -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan

# Get project ID if not provided
if ([string]::IsNullOrEmpty($ProjectId)) {
    Write-Host "Getting current project ID..."
    try {
        $ProjectId = & gcloud config get-value project 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Error "Failed to get current project ID. Please specify -ProjectId parameter."
            exit 1
        }
        Write-Host "Using project: $ProjectId" -ForegroundColor Green
    }
    catch {
        Write-Error "Failed to get project ID: $($_.Exception.Message)"
        exit 1
    }
}

# Validate inputs
if (-not $CleanupAll -and -not $CleanupStale -and $RunnerNames.Count -eq 0 -and $InstanceNames.Count -eq 0) {
    Write-Error "Please specify at least one of: -CleanupAll, -CleanupStale, -RunnerNames, or -InstanceNames"
    exit 1
}

# Create the cleanup message
$timestamp = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ" -AsUTC)
$cleanupData = @{
    triggerType = $TriggerType
    timestamp   = $timestamp
    projectId   = $ProjectId
    source      = "manual-powershell-trigger"
}

if ($CleanupAll) {
    $cleanupData.cleanupAll = $true
    Write-Host "🎯 Triggering cleanup for ALL offline runners" -ForegroundColor Yellow
}
elseif ($CleanupStale) {
    $cleanupData.action = "cleanup_stale_runners"
    Write-Host "🎯 Triggering cleanup for STALE runners" -ForegroundColor Yellow
}
else {
    if ($RunnerNames.Count -gt 0) {
        $cleanupData.runnerNames = $RunnerNames
        Write-Host "🎯 Triggering cleanup for specific runners:" -ForegroundColor Yellow
        $RunnerNames | ForEach-Object { Write-Host "   - $_" -ForegroundColor White }
    }
    
    if ($InstanceNames.Count -gt 0) {
        $cleanupData.instanceNames = $InstanceNames
        Write-Host "🎯 Triggering cleanup for instances:" -ForegroundColor Yellow
        $InstanceNames | ForEach-Object { Write-Host "   - $_" -ForegroundColor White }
    }
}

# Convert to JSON
$messageJson = $cleanupData | ConvertTo-Json -Compress

Write-Host "`n📤 Publishing cleanup message to Pub/Sub topic: $TopicName" -ForegroundColor Cyan
Write-Host "Message: $messageJson" -ForegroundColor Gray

try {
    # Publish the message to Pub/Sub
    $result = $messageJson | & gcloud pubsub topics publish $TopicName --message=- 2>&1
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✅ Successfully triggered hybrid cleanup!" -ForegroundColor Green
        Write-Host "Message ID: $result" -ForegroundColor Green
        
        Write-Host "`n⏱️  The cleanup will be processed by the Cloud Function within a few seconds." -ForegroundColor Cyan
        Write-Host "You can monitor the progress in the Cloud Functions logs." -ForegroundColor Cyan
        
        # Show how to check logs
        Write-Host "`n📊 To check the cleanup progress:" -ForegroundColor Yellow
        Write-Host "gcloud functions logs read hybrid-runner-cleanup --region=us-central1 --limit=50" -ForegroundColor White
    }
    else {
        Write-Error "Failed to publish message: $result"
        exit 1
    }
}
catch {
    Write-Error "Error publishing cleanup message: $($_.Exception.Message)"
    exit 1
}

# Optional: Wait and check results
$checkResults = Read-Host "`n🔍 Would you like to wait and check the cleanup results? (y/N)"
if ($checkResults -eq "y" -or $checkResults -eq "Y") {
    Write-Host "`n⏳ Waiting 30 seconds for cleanup to complete..." -ForegroundColor Cyan
    Start-Sleep -Seconds 30
    
    Write-Host "📊 Checking current runner status..." -ForegroundColor Cyan
    
    # Run the list-all-runners script to check current status
    $listScript = Join-Path $PSScriptRoot "list-all-runners.ps1"
    if (Test-Path $listScript) {
        & $listScript
    }
    else {
        Write-Warning "list-all-runners.ps1 script not found. Please check runner status manually."
    }
}

Write-Host "`n🎉 Hybrid cleanup trigger completed!" -ForegroundColor Green
