[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
function Set-GitHubWebhook {
    param([Parameter(Mandatory)][string]$WebhookUrl, [Parameter(Mandatory)][string]$RepoOwner, [Parameter(Mandatory)][string]$RepoName, [Parameter(Mandatory)][string]$WebhookSecret)
    $uri = $null
    if (-not [Uri]::TryCreate($WebhookUrl, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne 'https' -or $uri.UserInfo) { throw 'A deployed HTTPS webhook_url output is required.' }
    if ($RepoOwner -notmatch '^[A-Za-z0-9-]+$' -or $RepoName -notmatch '^[A-Za-z0-9_.-]+$') { throw 'Invalid repository coordinates.' }
    if ([string]::IsNullOrWhiteSpace($WebhookSecret)) { throw 'Webhook secret is required.' }
    $request = @{name='web'; active=$true; events=@('workflow_job'); config=@{url=$WebhookUrl; content_type='json'; secret=$WebhookSecret; insecure_ssl='0'}} | ConvertTo-Json -Depth 4 -Compress
    $request | & gh api --method POST "repos/$RepoOwner/$RepoName/hooks" --input - | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'GitHub webhook registration failed.' }
    Write-Output 'GitHub workflow_job webhook registered.'
}
foreach ($cli in @('terraform','gh')) { if (-not (Get-Command $cli -ErrorAction SilentlyContinue)) { throw "Missing prerequisite: $cli" } }
$root = Split-Path $PSScriptRoot -Parent
$url = (& terraform "-chdir=$root/terraform" output -raw webhook_url | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or -not $url) { throw 'A deployed webhook_url output is required.' }
$owner = Read-Host 'GitHub repository owner'
$repo = Read-Host 'GitHub repository name'
$secure = Read-Host 'Webhook secret matching the deployed secret version' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $secret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr); Set-GitHubWebhook -WebhookUrl $url -RepoOwner $owner -RepoName $repo -WebhookSecret $secret }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr); $secret = $null; $secure.Dispose() }
