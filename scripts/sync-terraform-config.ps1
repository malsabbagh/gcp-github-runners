[CmdletBinding()]
param([switch]$Deploy)
$ErrorActionPreference = 'Stop'
$python = if (Get-Command python3 -ErrorAction SilentlyContinue) { 'python3' } elseif (Get-Command python -ErrorAction SilentlyContinue) { 'python' } else { throw 'Python 3 is required.' }
$arguments = @((Join-Path $PSScriptRoot 'sync-terraform-config.py'), '--powershell')
if ($Deploy) { $arguments += '--deploy' }
& $python @arguments
if ($LASTEXITCODE -ne 0) { throw 'Terraform runtime configuration synchronization failed.' }
