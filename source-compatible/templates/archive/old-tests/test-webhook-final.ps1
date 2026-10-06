# Test GitHub webhook with proper payload structure
$secret = "PARITY_INPUT_347"
$webhookUrl = "https://cloudbuild.googleapis.com/v1/projects/PARITY_INPUT_064/triggers/67ebd656-833a-4a48-845b-1de039edabad:webhook"

# Proper GitHub workflow_job webhook payload
$payload = @{
    action       = "queued"
    workflow_job = @{
        id          = 999
        run_id      = 12345
        repository  = @{
            full_name = "PARITY_INPUT_010/VeraID"
            name      = "VeraID"
            owner     = @{
                login = "PARITY_INPUT_010"
            }
        }
        labels      = @("self-hosted", "rust")
        runs_on     = @("self-hosted")
        head_branch = "main"
        conclusion  = $null
        status      = "queued"
    }
    repository   = @{
        full_name = "PARITY_INPUT_010/VeraID"
        name      = "VeraID"
        owner     = @{
            login = "PARITY_INPUT_010"
        }
    }
} | ConvertTo-Json -Depth 10 -Compress

Write-Host "Testing GitHub webhook with correct payload structure..."
Write-Host "Payload: $payload"
Write-Host ""

# Calculate HMAC-SHA256 signature
$hmac = [System.Security.Cryptography.HMACSHA256]::new([System.Text.Encoding]::UTF8.GetBytes($secret))
$hash = $hmac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($payload))
$signature = "sha256=" + [System.BitConverter]::ToString($hash).Replace("-", "").ToLower()

Write-Host "Signature: $signature"
Write-Host ""

# Headers exactly as GitHub sends them
$headers = @{
    "Content-Type"        = "application/json"
    "User-Agent"          = "GitHub-Hookshot/test"
    "X-GitHub-Event"      = "workflow_job"
    "X-GitHub-Delivery"   = "test-delivery-001"
    "X-Hub-Signature-256" = $signature
}

Write-Host "Sending webhook request..."
try {
    $response = Invoke-RestMethod -Uri $webhookUrl -Method POST -Headers $headers -Body $payload -TimeoutSec 30
    Write-Host "SUCCESS! Response: $response" -ForegroundColor Green
}
catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.Exception.Response) {
        Write-Host "Status Code: $($_.Exception.Response.StatusCode)" -ForegroundColor Red
        try {
            $errorStream = $_.Exception.Response.GetResponseStream()
            $reader = [System.IO.StreamReader]::new($errorStream)
            $errorBody = $reader.ReadToEnd()
            Write-Host "Error Body: $errorBody" -ForegroundColor Red
        }
        catch {
            Write-Host "Could not read error response body" -ForegroundColor Yellow
        }
    }
}
