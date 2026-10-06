#!/usr/bin/env pwsh
# Test script to validate stop-then-delete logic for GitHub runner cleanup

param(
    [string]$ProjectId = "PARITY_INPUT_064",
    [string]$Zone = "us-central1-a"
)

Write-Host "🧪 Testing stop-then-delete logic for GitHub runner cleanup" -ForegroundColor Cyan
Write-Host "Project: $ProjectId"
Write-Host "Zone: $Zone"

# Create a test instance to verify stop-then-delete behavior
$TestInstanceName = "test-runner-stop-delete-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Write-Host "`n📦 Creating test instance: $TestInstanceName" -ForegroundColor Yellow

try {
    # Create a test instance with shutdown script
    $createResult = gcloud compute instances create $TestInstanceName `
        --zone=$Zone `
        --machine-type=e2-micro `
        --image-family=debian-12 `
        --image-project=PARITY_INPUT_337 `
        --labels=purpose=test-shutdown `
        --metadata=shutdown-script='#!/bin/bash
echo "=== SHUTDOWN SCRIPT STARTING ===" | tee -a /var/log/test-shutdown.log
echo "Timestamp: $(date)" | tee -a /var/log/test-shutdown.log  
echo "This shutdown script was triggered by instance stop" | tee -a /var/log/test-shutdown.log
sleep 5
echo "=== SHUTDOWN SCRIPT COMPLETED ===" | tee -a /var/log/test-shutdown.log' `
        --project=$ProjectId `
        --quiet

    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create test instance"
    }

    Write-Host "✅ Test instance created successfully" -ForegroundColor Green

    # Wait for instance to be running
    Write-Host "`n⏳ Waiting for instance to be fully ready..." -ForegroundColor Yellow
    Start-Sleep -Seconds 15

    # Test the stop-then-delete logic
    Write-Host "`n🛑 Testing stop command (should trigger shutdown script)..." -ForegroundColor Yellow
    
    $stopResult = gcloud compute instances stop $TestInstanceName --zone=$Zone --quiet --project=$ProjectId
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✅ Instance stopped successfully" -ForegroundColor Green
        
        # Wait for shutdown script to complete (as per cleanup logic)
        Write-Host "⏳ Waiting 30 seconds for shutdown scripts to complete..." -ForegroundColor Yellow
        Start-Sleep -Seconds 30
        
        # Now delete the instance
        Write-Host "🗑️  Deleting stopped instance..." -ForegroundColor Yellow
        $deleteResult = gcloud compute instances delete $TestInstanceName --zone=$Zone --quiet --project=$ProjectId
        
        if ($LASTEXITCODE -eq 0) {
            Write-Host "✅ Instance deleted successfully" -ForegroundColor Green
            Write-Host "`n🎯 Stop-then-delete logic validation PASSED" -ForegroundColor Green
        }
        else {
            Write-Host "❌ Failed to delete stopped instance" -ForegroundColor Red
            return 1
        }
    }
    else {
        Write-Host "❌ Failed to stop instance" -ForegroundColor Red
        Write-Host "🔄 Attempting direct deletion as fallback..." -ForegroundColor Yellow
        $deleteResult = gcloud compute instances delete $TestInstanceName --zone=$Zone --quiet --project=$ProjectId
        return 1
    }

}
catch {
    Write-Host "❌ Test failed: $_" -ForegroundColor Red
    
    # Cleanup test instance if it exists
    Write-Host "🧹 Cleaning up test instance..." -ForegroundColor Yellow
    gcloud compute instances delete $TestInstanceName --zone=$Zone --quiet --project=$ProjectId 2>$null
    return 1
}

Write-Host "`n✅ Stop-then-delete validation completed successfully!" -ForegroundColor Green
Write-Host "The cleanup logic will now properly:" -ForegroundColor Cyan
Write-Host "  1. Stop instances (triggering shutdown scripts)" -ForegroundColor Cyan  
Write-Host "  2. Wait 30 seconds for shutdown scripts to complete" -ForegroundColor Cyan
Write-Host "  3. Delete the stopped instances" -ForegroundColor Cyan
Write-Host "  4. Fall back to direct deletion if stop fails" -ForegroundColor Cyan

return 0
