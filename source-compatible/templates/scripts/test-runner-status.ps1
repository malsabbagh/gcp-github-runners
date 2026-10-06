#!/usr/bin/env pwsh

Write-Host "Testing PAT and checking runner status..."

# Get PAT
$pat = & gcloud secrets versions access latest --secret="github-runner-token" 2>$null
if (!$pat) {
    Write-Error "Failed to retrieve PAT"
    exit 1
}

Write-Host "PAT retrieved successfully"

# Set headers
$headers = @{
    'Authorization' = "Bearer $pat"
    'Accept' = 'application/vnd.github+json'
    'User-Agent' = 'github-runner-gce'
}

try {
    # Get runners
    $response = Invoke-RestMethod -Uri "https://api.github.com/repos/PARITY_INPUT_010/VeraID/actions/runners" -Headers $headers -Method GET
    
    Write-Host "`nTotal runners: $($response.total_count)"
    
    # Show status breakdown
    $online = $response.runners | Where-Object { $_.status -eq "online" }
    $offline = $response.runners | Where-Object { $_.status -eq "offline" }
    
    Write-Host "Online runners: $($online.Count)"
    Write-Host "Offline runners: $($offline.Count)"
    
    # Show validation runners
    $validationRunners = $response.runners | Where-Object { $_.name -like "*validation*" }
    if ($validationRunners.Count -gt 0) {
        Write-Host "`nValidation runners:"
        $validationRunners | ForEach-Object {
            $statusIcon = if ($_.status -eq "online") { "✅" } else { "❌" }
            Write-Host "  $statusIcon $($_.name) (Status: $($_.status))"
        }
        
        # Clean up offline validation runners
        $offlineValidation = $validationRunners | Where-Object { $_.status -eq "offline" }
        if ($offlineValidation.Count -gt 0) {
            Write-Host "`nCleaning up $($offlineValidation.Count) offline validation runners..."
            foreach ($runner in $offlineValidation) {
                try {
                    Write-Host "Deleting runner $($runner.name) (ID: $($runner.id))..."
                    $deleteResponse = Invoke-RestMethod -Uri "https://api.github.com/repos/PARITY_INPUT_010/VeraID/actions/runners/$($runner.id)" -Headers $headers -Method DELETE
                    Write-Host "  ✅ Successfully deleted $($runner.name)"
                } catch {
                    Write-Host "  ❌ Failed to delete $($runner.name): $($_.Exception.Message)"
                }
                Start-Sleep -Seconds 1
            }
        }
    } else {
        Write-Host "`nNo validation runners found"
    }
    
} catch {
    Write-Error "API request failed: $($_.Exception.Message)"
    if ($_.ErrorDetails) {
        Write-Error "Details: $($_.ErrorDetails.Message)"
    }
}
