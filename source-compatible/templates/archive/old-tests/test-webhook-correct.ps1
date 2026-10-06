# Test with exact payload received by the function
$secret = "PARITY_INPUT_347"

# This is the exact payload the function logged as "Full payload"
$actualPayload = '{"workflow_job":{"repository":{"full_name":"PARITY_INPUT_010/VeraID"},"run_id":"12345","runs_on":["self-hosted"],"id":"999","status":"queued","conclusion":null,"head_branch":"main","labels":["self-hosted","rust"]},"action":"queued","repository":{"full_name":"PARITY_INPUT_010/VeraID","name":"VeraID","owner":{"login":"PARITY_INPUT_010"}}}'

Write-Host "Testing with exact payload from function logs..."
Write-Host "Payload: $actualPayload"
Write-Host ""

# Calculate the signature that should be generated for this payload
$hmac = [System.Security.Cryptography.HMACSHA256]::new([System.Text.Encoding]::UTF8.GetBytes($secret))
$hash = $hmac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($actualPayload))
$correctSignature = "sha256=" + [System.BitConverter]::ToString($hash).Replace("-", "").ToLower()

Write-Host "Correct signature for this payload: $correctSignature"

# Send webhook request with the correct signature
$headers = @{
    "Content-Type"        = "application/json"
    "x-github-event"      = "workflow_job"
    "x-github-delivery"   = "test-correct-signature-001"
    "x-hub-signature-256" = $correctSignature
}

try {
    $response = Invoke-RestMethod -Uri "https://github-webhook-handler-w7wbppyxua-uc.a.run.app" -Method POST -Headers $headers -Body $actualPayload
    Write-Host "SUCCESS! Response: $response"
}
catch {
    Write-Host "Error: $($_.Exception.Message)"
}
