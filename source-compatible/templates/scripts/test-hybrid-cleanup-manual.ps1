# Manual Test for Hybrid Cleanup System
# This script tests the hybrid cleanup Cloud Function with a manual trigger

$ErrorActionPreference = "Stop"

# Configuration
$project_id = "PARITY_INPUT_064"
$topic_name = "hybrid-cleanup-events"

# Create a test cleanup message
$test_message = @{
    triggerType  = "manual_test"
    instanceName = "test-hybrid-cleanup"
    runnerNames  = @("test-hybrid-cleanup-abc123-1", "test-hybrid-cleanup-abc123-2")
    timestamp    = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
    source       = "manual-test-script"
    projectId    = $project_id
} | ConvertTo-Json -Compress

Write-Host "Test message: $test_message"

# Publish to Pub/Sub topic
Write-Host "Publishing test message to Pub/Sub topic: $topic_name"
$message_b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($test_message))

try {
    $result = gcloud pubsub topics publish $topic_name --message=$message_b64 2>&1
    Write-Host "Message published successfully: $result"
    
    # Wait a moment for processing
    Write-Host "Waiting 10 seconds for Cloud Function processing..."
    Start-Sleep -Seconds 10
    
    # Check Cloud Function logs
    Write-Host "Checking Cloud Function logs..."
    gcloud functions logs read hybrid-cleanup-handler --limit=5
    
}
catch {
    Write-Error "Failed to publish message: $($_.Exception.Message)"
}
