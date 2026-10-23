Set-StrictMode -Version Latest

function Resolve-RunnerWebhookUrl {
    param([AllowEmptyString()][string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -match '[\s\x00-\x1f\x7f\\`$"''<>]' -or
        $Value -notmatch '^https://[A-Za-z0-9.-]+(?::443)?(?:/[A-Za-z0-9/_-]*)?$') {
        throw 'Supply WebhookUrl or GCP_RUNNER_WEBHOOK_URL as an absolute HTTPS endpoint without credentials, query or fragment.'
    }
    $uri = $null
    if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -ne 'https' -or $uri.HostNameType -ne [UriHostNameType]::Dns -or
        $uri.Port -ne 443 -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or
        $uri.Host -notmatch '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$' -or
        $uri.Host -match '(?:^|\.)(?:localhost|local|internal)$') {
        throw 'Invalid webhook endpoint.'
    }
    return $uri
}

function Invoke-RunnerWebhookTest {
    param([Uri]$Uri, [string]$RepositoryOwner, [string]$RepositoryName, [long]$RepositoryId, [string]$WebhookSecret)
    if ($RepositoryId -lt 1 -or $RepositoryId -gt 9007199254740991 -or $RepositoryOwner -notmatch '^[A-Za-z0-9][A-Za-z0-9-]{0,38}$' -or
        $RepositoryName -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$' -or
        [string]::IsNullOrWhiteSpace($WebhookSecret) -or $WebhookSecret.StartsWith('PARITY_INPUT_')) {
        throw 'Supply repository owner/name and the existing webhook secret through private operator inputs.'
    }
    $payload = @{
        action = 'queued'
        workflow_job = @{ id = 999; run_id = 12345; run_attempt = 1; labels = @('self-hosted', 'gcp-one-job'); head_branch = 'main' }
        repository = @{ owner = @{login = $RepositoryOwner}; name = $RepositoryName; id = $RepositoryId; private = $true }
    } | ConvertTo-Json -Depth 5 -Compress
    $hmac = [System.Security.Cryptography.HMACSHA256]::new([System.Text.Encoding]::UTF8.GetBytes($WebhookSecret))
    try { $digest = $hmac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($payload)) }
    finally { $hmac.Dispose() }
    $headers = @{'x-github-event' = 'workflow_job'; 'x-github-delivery' = [Guid]::NewGuid().ToString();
        'x-hub-signature-256' = 'sha256=' + [Convert]::ToHexString($digest).ToLowerInvariant() }
    try {
        $null = Invoke-RestMethod -Uri $Uri -Method POST -ContentType 'application/json' -Headers $headers -Body $payload -MaximumRedirection 0 -TimeoutSec 30
    } catch { throw 'Webhook request failed. Check the endpoint and authentication using private diagnostics.' }
    Write-Host 'Webhook test request completed. A response does not establish deployment readiness.'
}
