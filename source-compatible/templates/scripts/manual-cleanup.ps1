# Manual cleanup script for GitHub runner VMs (PowerShell)
# Run this when workflows complete

Write-Host "🧹 Starting GitHub runner VM cleanup..." -ForegroundColor Yellow

# Find and delete old runner instances (older than 1 hour)
$cutoffTime = (Get-Date).AddHours(-1).ToString("yyyy-MM-ddTHH:mm:ss.000Z")

Write-Host "Looking for instances older than: $cutoffTime" -ForegroundColor Blue

$instances = & gcloud compute instances list --filter="labels.purpose=github-runner AND creationTimestamp<$cutoffTime" --format="value(name,zone)"

if ($instances) {
    $instances | ForEach-Object {
        $parts = $_ -split '\s+'
        $name = $parts[0]
        $zone = $parts[1]
        
        if ($name) {
            Write-Host "🗑️ Deleting instance: $name in zone $zone" -ForegroundColor Red
            & gcloud compute instances delete $name --zone=$zone --quiet
        }
    }
}
else {
    Write-Host "✅ No old instances found to cleanup" -ForegroundColor Green
}

Write-Host "✅ Cleanup completed!" -ForegroundColor Green
