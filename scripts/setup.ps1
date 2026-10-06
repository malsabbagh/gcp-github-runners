[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
function ConvertTo-HclString {
    param([string]$Value)
    return ConvertTo-Json -InputObject ($Value.Replace('${', '$${').Replace('%{', '%%{')) -Compress
}
function Read-SecretReference {
    param([string]$DefaultValue)
    $prompt = if ($DefaultValue) { 'Numbered secret version reference [***masked***]' } else { 'Numbered secret version reference' }
    $secure = Read-Host $prompt -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr); $secure.Dispose() }
    if ($value.Length -eq 0) { $value = $DefaultValue }
    if (-not $value) { throw 'Secret reference is required' }
    if ([string]::IsNullOrWhiteSpace($value)) { throw 'Secret reference cannot be whitespace' }
    return $value
}
$root = Split-Path $PSScriptRoot -Parent
$tfvarsPath = Join-Path $root 'terraform/terraform.tfvars'
$defaults = @{}
if (Test-Path $tfvarsPath) {
    foreach ($line in Get-Content $tfvarsPath) {
        if ($line -match '^\s*([a-z_]+)\s*=\s*(".*")\s*$') {
            $defaults[$Matches[1]] = ($Matches[2] | ConvertFrom-Json).Replace('$${', '${').Replace('%%{', '%{')
        }
    }
}
# Prompt for config
if (Test-Path $tfvarsPath) { throw 'terraform.tfvars exists; edit it deliberately or move it aside first.' }
$PROJECT_ID = Read-Host 'project_id'
if ([string]::IsNullOrWhiteSpace($PROJECT_ID)) { throw 'Required input: project_id' }
$REGION = Read-Host 'region'
if ([string]::IsNullOrWhiteSpace($REGION)) { throw 'Required input: region' }
$ZONE = Read-Host 'zone'
if ([string]::IsNullOrWhiteSpace($ZONE)) { throw 'Required input: zone' }
$REPOSITORY_OWNER = Read-Host 'repository_owner'
if ([string]::IsNullOrWhiteSpace($REPOSITORY_OWNER)) { throw 'Required input: repository_owner' }
$REPOSITORY_NAME = Read-Host 'repository_name'
if ([string]::IsNullOrWhiteSpace($REPOSITORY_NAME)) { throw 'Required input: repository_name' }
$REPOSITORY_BRANCH = Read-Host 'repository_branch'
if ([string]::IsNullOrWhiteSpace($REPOSITORY_BRANCH)) { throw 'Required input: repository_branch' }
$WORKER_IMAGE = Read-Host 'worker_image'
if ([string]::IsNullOrWhiteSpace($WORKER_IMAGE)) { throw 'Required input: worker_image' }
$BUILDER_IMAGE = Read-Host 'builder_image'
if ([string]::IsNullOrWhiteSpace($BUILDER_IMAGE)) { throw 'Required input: builder_image' }
$FUNCTION_BUILD_SERVICE_ACCOUNT = Read-Host 'function_build_service_account'
if ([string]::IsNullOrWhiteSpace($FUNCTION_BUILD_SERVICE_ACCOUNT)) { throw 'Required input: function_build_service_account' }
$CONTROLLER_ARCHIVE_PATH = Read-Host 'controller_archive_path'
if ([string]::IsNullOrWhiteSpace($CONTROLLER_ARCHIVE_PATH)) { throw 'Required input: controller_archive_path' }
$WEBHOOK_SECRET_VERSION = Read-Host 'webhook_secret_version'
if ([string]::IsNullOrWhiteSpace($WEBHOOK_SECRET_VERSION)) { throw 'Required input: webhook_secret_version' }
$GITHUB_APP_PRIVATE_KEY_SECRET_VERSION = Read-Host 'github_app_private_key_secret_version'
if ([string]::IsNullOrWhiteSpace($GITHUB_APP_PRIVATE_KEY_SECRET_VERSION)) { throw 'Required input: github_app_private_key_secret_version' }
$GITHUB_APP_ID = Read-Host 'github_app_id'
if ([string]::IsNullOrWhiteSpace($GITHUB_APP_ID)) { throw 'Required input: github_app_id' }
$GITHUB_APP_INSTALLATION_ID = Read-Host 'github_app_installation_id'
if ([string]::IsNullOrWhiteSpace($GITHUB_APP_INSTALLATION_ID)) { throw 'Required input: github_app_installation_id' }
$GITHUB_REPOSITORY_ID = Read-Host 'github_repository_id'
if ([string]::IsNullOrWhiteSpace($GITHUB_REPOSITORY_ID)) { throw 'Required input: github_repository_id' }
$RUNNER_GROUP_ID = Read-Host 'runner_group_id'
if ([string]::IsNullOrWhiteSpace($RUNNER_GROUP_ID)) { throw 'Required input: runner_group_id' }
$ADMIN_SUBJECT = Read-Host 'admin_subject'
if ([string]::IsNullOrWhiteSpace($ADMIN_SUBJECT)) { throw 'Required input: admin_subject' }
$tfvarsContent = @"
project_id = $(ConvertTo-HclString $PROJECT_ID)
region = $(ConvertTo-HclString $REGION)
zone = $(ConvertTo-HclString $ZONE)
repository_owner = $(ConvertTo-HclString $REPOSITORY_OWNER)
repository_name = $(ConvertTo-HclString $REPOSITORY_NAME)
repository_branch = $(ConvertTo-HclString $REPOSITORY_BRANCH)
worker_image = $(ConvertTo-HclString $WORKER_IMAGE)
builder_image = $(ConvertTo-HclString $BUILDER_IMAGE)
function_build_service_account = $(ConvertTo-HclString $FUNCTION_BUILD_SERVICE_ACCOUNT)
controller_archive_path = $(ConvertTo-HclString $CONTROLLER_ARCHIVE_PATH)
webhook_secret_version = $(ConvertTo-HclString $WEBHOOK_SECRET_VERSION)
github_app_private_key_secret_version = $(ConvertTo-HclString $GITHUB_APP_PRIVATE_KEY_SECRET_VERSION)
github_app_id = $(ConvertTo-HclString $GITHUB_APP_ID)
github_app_installation_id = $(ConvertTo-HclString $GITHUB_APP_INSTALLATION_ID)
github_repository_id = $(ConvertTo-HclString $GITHUB_REPOSITORY_ID)
runner_group_id = $(ConvertTo-HclString $RUNNER_GROUP_ID)
admin_subject = $(ConvertTo-HclString $ADMIN_SUBJECT)
"@
# Restrict local operator input permissions on POSIX; Windows inherits the operator directory ACL.
[IO.File]::WriteAllText($tfvarsPath, $tfvarsContent, (New-Object Text.UTF8Encoding($false)))
if ($IsLinux -or $IsMacOS) { & chmod 600 $tfvarsPath; if ($LASTEXITCODE -ne 0) { throw 'Could not restrict input file permissions.' } }
Write-Output 'Created ignored terraform/terraform.tfvars. Review it, then run terraform init and terraform plan deliberately. Nothing was deployed.'
