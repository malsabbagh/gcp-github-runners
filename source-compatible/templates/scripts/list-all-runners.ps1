#!/usr/bin/env pwsh

param(
    [Parameter(Mandatory = $false)]
    [string]$RepoOwner = "PARITY_INPUT_010",
    
    [Parameter(Mandatory = $false)]
    [string]$RepoName = "VeraID"
)

Write-Host "Fetching GitHub PAT from Secret Manager..."
try {
    $pat = & gcloud secrets versions access latest --secret="github-runner-token" 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to retrieve GitHub PAT: $pat"
        exit 1
    }
}
catch {
    Write-Error "Failed to retrieve GitHub PAT: $($_.Exception.Message)"
    exit 1
}

Write-Host "Listing all runners for $RepoOwner/$RepoName..."

$headers = @{
    'Authorization' = "Bearer $pat"
    'Accept'        = 'application/vnd.github+json'
    'User-Agent'    = 'github-runner-gce'
}

try {
    $page = 1
    $allRunners = @()
    
    do {
        $response = Invoke-RestMethod -Uri "https://api.github.com/repos/$RepoOwner/$RepoName/actions/runners?per_page=100&page=$page" -Headers $headers -Method GET
        $allRunners += $response.runners
        $page++
    } while ($response.runners.Count -eq 100)
    
    Write-Host "`nFound $($allRunners.Count) total runners:"
    
    if ($allRunners.Count -eq 0) {
        Write-Host "No runners found in repository"
        return
    }
    
    # Group by status
    $onlineRunners = $allRunners | Where-Object { $_.status -eq "online" }
    $offlineRunners = $allRunners | Where-Object { $_.status -eq "offline" }
    
    Write-Host "`n=== ONLINE RUNNERS ($($onlineRunners.Count)) ==="
    $onlineRunners | Sort-Object name | ForEach-Object {
        $labels = $_.labels.name -join ','
        Write-Host "  ✅ $($_.name) (OS: $($_.os), Labels: $labels)"
    }
    
    if ($offlineRunners.Count -gt 0) {
        Write-Host "`n=== OFFLINE RUNNERS ($($offlineRunners.Count)) ==="
        $offlineRunners | Sort-Object name | ForEach-Object {
            $labels = $_.labels.name -join ','
            Write-Host "  ❌ $($_.name) (OS: $($_.os), Labels: $labels)"
        }
    }
    
    # Show validation runners specifically
    $validationRunners = $allRunners | Where-Object { $_.name -like "*validation*" }
    if ($validationRunners.Count -gt 0) {
        Write-Host "`n=== VALIDATION RUNNERS ($($validationRunners.Count)) ==="
        $validationRunners | Sort-Object name | ForEach-Object {
            $status = if ($_.status -eq "online") { "✅" } else { "❌" }
            $labels = $_.labels.name -join ','
            Write-Host "  $status $($_.name) (Status: $($_.status), OS: $($_.os), Labels: $labels)"
        }
    }
    
}
catch {
    Write-Error "Failed to list runners: $($_.Exception.Message)"
    if ($_.ErrorDetails) {
        Write-Error "Details: $($_.ErrorDetails.Message)"
    }
    exit 1
}
