# Test with exact signature from logs
$secret = "PARITY_INPUT_347"

# Test signature that the function calculated as expected
$payload1 = '{"workflow_job":{"repository":{"full_name":"PARITY_INPUT_010/VeraID"},"run_id":"12345","runs_on":["self-hosted"],"id":"999","status":"queued","conclusion":null,"head_branch":"main","labels":["self-hosted","rust"]},"action":"queued","repository":{"full_name":"PARITY_INPUT_010/VeraID","name":"VeraID","owner":{"login":"PARITY_INPUT_010"}}}'
$signature1 = "sha256=d42872285b210804ab276f02fe1cc8ecc6867a72d935510a25076e5b6f5347903"

Write-Host "Testing with expected signature from logs..."
Write-Host "Payload length: $($payload1.Length)"

# Verify this signature is correct
$hmac = [System.Security.Cryptography.HMACSHA256]::new([System.Text.Encoding]::UTF8.GetBytes($secret))
$hash = $hmac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($payload1))
$calculatedSignature = "sha256=" + [System.BitConverter]::ToString($hash).Replace("-", "").ToLower()

Write-Host "Calculated signature: $calculatedSignature"
Write-Host "Expected from logs:   $signature1"
Write-Host "Signatures match: $($calculatedSignature -eq $signature1)"

if ($calculatedSignature -eq $signature1) {
    Write-Host "Perfect! Using the expected signature..."
    
    $headers = @{
        "Content-Type"        = "application/json"
        "x-github-event"      = "workflow_job"
        "x-github-delivery"   = "test-exact-match-001"
        "x-hub-signature-256" = $signature1
    }
    
    try {
        $response = Invoke-RestMethod -Uri "https://github-webhook-handler-w7wbppyxua-uc.a.run.app" -Method POST -Headers $headers -Body $payload1
        Write-Host "SUCCESS! Response: $response"
    }
    catch {
        Write-Host "Error: $($_.Exception.Message)"
        Write-Host "Response: $($_.Exception.Response)"
    }
}
else {
    Write-Host "Signatures don't match - there's still an issue"
}
