# Signed synthetic webhook diagnostic. Use only an explicitly authorized endpoint.
[CmdletBinding()]
param(
    [AllowEmptyString()][string]$WebhookUrl,
    [string]$RepositoryOwner = "PARITY_INPUT_010",
    [string]$RepositoryName,
    [long]$RepositoryId,
    [string]$WebhookSecret = "PARITY_INPUT_347"
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts/webhook-inputs.ps1')
$value = if ($PSBoundParameters.ContainsKey('WebhookUrl')) { $WebhookUrl } else { $env:GCP_RUNNER_WEBHOOK_URL }
$endpoint = Resolve-RunnerWebhookUrl -Value $value
Invoke-RunnerWebhookTest -Uri $endpoint -RepositoryOwner $RepositoryOwner -RepositoryName $RepositoryName -RepositoryId $RepositoryId -WebhookSecret $WebhookSecret
