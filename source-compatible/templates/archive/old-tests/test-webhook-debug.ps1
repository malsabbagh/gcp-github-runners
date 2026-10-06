# Test to see what payload format the Cloud Function receives
$payload = @{
    action       = "queued"
    workflow_job = @{
        id          = "999"
        run_id      = "12345"
        repository  = @{
            full_name = "PARITY_INPUT_010/VeraID"
        }
        labels      = @("self-hosted", "rust")
        runs_on     = @("self-hosted")
        head_branch = "main"
        conclusion  = $null
        status      = "queued"
    }
    repository   = @{
        full_name = "PARITY_INPUT_010/VeraID"
        owner     = @{
            login = "PARITY_INPUT_010"
        }
        name      = "VeraID"
    }
} | ConvertTo-Json -Depth 5 -Compress

Write-Host "PowerShell payload:"
Write-Host $payload
Write-Host ""

# Convert to Node.js style (alphabetically ordered)
$payloadObj = $payload | ConvertFrom-Json
$nodePayload = $payloadObj | ConvertTo-Json -Depth 5 -Compress
Write-Host "Node.js style payload:"
Write-Host $nodePayload
Write-Host ""

# Test with the exact payload format from the logs
$expectedPayload = '{"workflow_job":{"repository":{"full_name":"PARITY_INPUT_010/VeraID"},"run_id":"12345","runs_on":["self-hosted"],"id":"999","status":"queued","conclusion":null,"head_branch":"main","labels":["self-hosted","rust"]},"action":"queued","repository":{"full_name":"PARITY_INPUT_010/VeraID","name":"VeraID","owner":{"login":"PARITY_INPUT_010"}}}'

Write-Host "Expected payload from logs:"
Write-Host $expectedPayload
Write-Host ""

$secret = "PARITY_INPUT_347"

# Create HMAC SHA256 signature for the expected payload
$hmac = [System.Security.Cryptography.HMACSHA256]::new([System.Text.Encoding]::UTF8.GetBytes($secret))
$hash = $hmac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($expectedPayload))
$expectedSignature = "sha256=" + [System.BitConverter]::ToString($hash).Replace("-", "").ToLower()

Write-Host "Expected signature: $expectedSignature"

# Send webhook request with the exact expected payload
$headers = @{
    "Content-Type"        = "application/json"
    "x-github-event"      = "workflow_job"
    "x-github-delivery"   = "test-expected-webhook-001"
    "x-hub-signature-256" = $expectedSignature
}

try {
    $response = Invoke-RestMethod -Uri "https://github-webhook-handler-w7wbppyxua-uc.a.run.app" -Method POST -Headers $headers -Body $expectedPayload
    Write-Host "Response: $response"
}
catch {
    Write-Host "Error: $($_.Exception.Message)"
}
