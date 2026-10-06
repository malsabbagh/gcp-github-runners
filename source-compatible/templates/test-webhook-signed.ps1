# Test GitHub webhook with proper signature
$secret = "PARITY_INPUT_347"
$payload = @{
    action = "queued"
    workflow_job = @{
        id = "999"
        run_id = "12345"
        repository = @{
            full_name = "PARITY_INPUT_010/VeraID"
        }
        labels = @("self-hosted", "rust")
        runs_on = @("self-hosted")
        head_branch = "main"
        conclusion = $null
        status = "queued"
    }
    repository = @{
        full_name = "PARITY_INPUT_010/VeraID"
        owner = @{
            login = "PARITY_INPUT_010"
        }
        name = "VeraID"
    }
} | ConvertTo-Json -Depth 5 -Compress

Write-Host "Payload: $payload"

# Create HMAC SHA256 signature
$hmac = [System.Security.Cryptography.HMACSHA256]::new([System.Text.Encoding]::UTF8.GetBytes($secret))
$hash = $hmac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($payload))
$signature = "sha256=" + [System.BitConverter]::ToString($hash).Replace("-", "").ToLower()

Write-Host "Signature: $signature"

# Send webhook request
$headers = @{
    "Content-Type" = "application/json"
    "x-github-event" = "workflow_job"
    "x-github-delivery" = "test-signed-webhook-001"
    "x-hub-signature-256" = $signature
}

try {
    $response = Invoke-RestMethod -Uri "https://github-webhook-handler-w7wbppyxua-uc.a.run.app" -Method POST -Headers $headers -Body $payload
    Write-Host "Response: $response"
} catch {
    Write-Host "Error: $($_.Exception.Message)"
    Write-Host "Response: $($_.Exception.Response)"
}
