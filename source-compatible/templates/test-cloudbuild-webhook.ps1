# Test Cloud Build webhook trigger directly
$secret = "PARITY_INPUT_347"

# Test payload for Cloud Build webhook
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

Write-Host "Testing Cloud Build webhook trigger..."
Write-Host "Payload: $payload"
Write-Host ""

# Calculate signature for Cloud Build webhook
$hmac = [System.Security.Cryptography.HMACSHA256]::new([System.Text.Encoding]::UTF8.GetBytes($secret))
$hash = $hmac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($payload))
$signature = "sha256=" + [System.BitConverter]::ToString($hash).Replace("-", "").ToLower()

Write-Host "Signature: $signature"

# Cloud Build webhook URL from Terraform output
$webhookUrl = "https://cloudbuild.googleapis.com/v1/projects/PARITY_INPUT_064/triggers/67ebd656-833a-4a48-845b-1de039edabad:webhook"

$headers = @{
    "Content-Type"        = "application/json"
    "x-github-event"      = "workflow_job"
    "x-github-delivery"   = "test-cloudbuild-001"
    "x-hub-signature-256" = $signature
}

try {
    Write-Host "Sending webhook to Cloud Build trigger..."
    $response = Invoke-RestMethod -Uri $webhookUrl -Method POST -Headers $headers -Body $payload
    Write-Host "SUCCESS! Response: $response"
}
catch {
    Write-Host "Error: $($_.Exception.Message)"
    if ($_.Exception.Response) {
        $responseStream = $_.Exception.Response.GetResponseStream()
        $reader = New-Object System.IO.StreamReader($responseStream)
        $responseText = $reader.ReadToEnd()
        Write-Host "Response content: $responseText"
    }
}
