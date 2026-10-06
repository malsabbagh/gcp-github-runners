[CmdletBinding()]
param()
# Local inspection only. No authentication, installation, or cloud calls.
$missing = 0
foreach ($cli in @('git','node','npm','terraform','gcloud','gh')) {
    if (Get-Command $cli -ErrorAction SilentlyContinue) { Write-Output "${cli}: available" }
    else { Write-Output "${cli}: missing"; $missing = 1 }
}
if (-not ((Get-Command python3 -ErrorAction SilentlyContinue) -or (Get-Command python -ErrorAction SilentlyContinue))) { Write-Output 'Python 3: missing'; $missing = 1 }
if (Get-Command node -ErrorAction SilentlyContinue) {
    $major = & node -p 'Number(process.versions.node.split(".")[0])'
    if ($LASTEXITCODE -ne 0 -or [int]$major -lt 24) { Write-Output 'Node.js 24 or newer is required.'; $missing = 1 }
}
exit $missing
