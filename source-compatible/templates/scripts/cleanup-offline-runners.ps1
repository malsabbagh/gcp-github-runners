param(
    [Parameter(Mandatory = $true)][string]$RepoOwner,
    [Parameter(Mandatory = $true)][string]$RepoName,
    [string]$NamePrefix = '',
    [string]$TokenSecretName = 'github-runner-token'
)

$ErrorActionPreference = 'Stop'

Write-Host "Fetching GitHub PAT from Secret Manager..."
$pat = (gcloud secrets versions access latest --secret $TokenSecretName).Trim()
if (-not $pat) { throw "Failed to retrieve PAT from Secret Manager" }

$baseUri = "https://api.github.com/repos/$RepoOwner/$RepoName/actions/runners"
$headers = @{ Authorization = "Bearer $pat"; Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }

Write-Host "Listing runners for $RepoOwner/$RepoName..."
$runners = @()
$page = 1
while ($true) {
    $uri = "$( $baseUri )?per_page=100&page=$page"
    $resp = Invoke-RestMethod -Method Get -Headers $headers -Uri $uri
    if (-not $resp.runners) { break }
    $runners += $resp.runners
    if ($resp.runners.Count -lt 100) { break }
    $page++
}

if ($NamePrefix) {
    $runners = $runners | Where-Object { $_.name -like ($NamePrefix + '*') }
}

$offline = @($runners | Where-Object { $_.status -eq 'offline' })
Write-Host ("Found {0} offline runners{1}" -f $offline.Count, $(if ($NamePrefix) { " with prefix '$NamePrefix'" } else { '' }))
if ($offline.Count -eq 0) { return }

foreach ($r in $offline) {
    $id = $r.id
    $name = $r.name
    Write-Host "Deleting runner $name (id: $id) ..."
    $delUri = "$( $baseUri )/$id"
    try {
        $resp = Invoke-WebRequest -Method Delete -Headers $headers -Uri $delUri -PassThru -ErrorAction Stop
        if ($resp.StatusCode -eq 204) {
            Write-Host "✓ Deleted $name"
        }
        else {
            Write-Warning "Unexpected status $($resp.StatusCode) for $name"
        }
    }
    catch {
        $status = 0
        try { $status = [int]$_.Exception.Response.StatusCode } catch { }
        if ($status -eq 204) {
            Write-Host "✓ Deleted $name"
        }
        else {
            Write-Warning "Failed to delete $name (HTTP $status)"
        }
    }
}
