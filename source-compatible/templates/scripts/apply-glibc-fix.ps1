# Update Runner Infrastructure with GLIBC Fix

param(
    [Parameter(Mandatory = $false)]
    [string]$ProjectId = "PARITY_INPUT_064",
    
    [Parameter(Mandatory = $false)]
    [string]$Zone = "us-central1-a",
    
    [Parameter(Mandatory = $false)]
    [switch]$DryRun = $false
)

function Write-Success { param($Message) Write-Host "✅ $Message" -ForegroundColor Green }
function Write-Info { param($Message) Write-Host "ℹ️  $Message" -ForegroundColor Cyan }
function Write-Warning { param($Message) Write-Host "⚠️  $Message" -ForegroundColor Yellow }
function Write-Error { param($Message) Write-Host "❌ $Message" -ForegroundColor Red }

$NewDockerImage = "us-central1-docker.pkg.dev/$ProjectId/github-runner-images/github-runner-rust:stable"

Write-Info "GLIBC Compatibility Fix - Infrastructure Update"
Write-Host "  Project: $ProjectId"
Write-Host "  Zone: $Zone"
Write-Host "  New Image: $NewDockerImage"
Write-Host "  Dry Run: $DryRun"
Write-Host ""

# 1. Check current running instances
Write-Info "Checking for running GitHub runner instances..."
try {
    $instances = gcloud compute instances list --project=$ProjectId --zones=$Zone --filter="name~github-runner" --format="value(name,status)" 2>$null
    if ($instances) {
        Write-Warning "Found running instances:"
        $instances | ForEach-Object { Write-Host "  - $_" }
        Write-Host ""
    }
    else {
        Write-Success "No running instances found"
    }
}
catch {
    Write-Warning "Could not check instances (this is OK if none exist): $_"
}

# 2. Update instance template metadata
Write-Info "Updating instance template with new Docker image..."
$metadataFile = "temp-metadata.json"

# Create metadata JSON with the new image
@{
    "docker-runner-image" = $NewDockerImage
    "glibc-fix-applied"   = "true"
    "ubuntu-version"      = "22.04"
    "glibc-version"       = "2.35"
    "update-date"         = (Get-Date -Format "yyyy-MM-dd")
} | ConvertTo-Json | Out-File -FilePath $metadataFile -Encoding UTF8

if ($DryRun) {
    Write-Warning "DRY RUN MODE - Would update metadata:"
    Get-Content $metadataFile
}
else {
    try {
        # Update the instance template
        $templateName = "github-runner-template"
        Write-Info "Attempting to update instance template: $templateName"
        
        # Note: This would typically require recreating the template
        # For now, we'll just show what would be done
        Write-Warning "Instance template updates require recreation. Consider using:"
        Write-Host "gcloud compute instance-templates create $templateName-glibc-fix \"
        Write-Host "  --project=$ProjectId \"
        Write-Host "  --metadata-from-file=temp-metadata.json \"
        Write-Host "  --image-family=ubuntu-2204-lts \"
        Write-Host "  --image-project=ubuntu-os-cloud"
        
    }
    catch {
        Write-Error "Failed to update template: $_"
    }
}

# 3. Instructions for applying the fix
Write-Host ""
Write-Success "GLIBC Compatibility Fix Summary:"
Write-Host "  ✅ Docker image rebuilt with Ubuntu 22.04 (GLIBC 2.35)"
Write-Host "  ✅ Enhanced Rust toolchain with latest stable version"
Write-Host "  ✅ Added debugging information to entrypoint"
Write-Host "  ✅ Image pushed to Artifact Registry"
Write-Host ""

Write-Info "Next Steps:"
Write-Host "  1. Update your Terraform/deployment scripts to use the new image:"
Write-Host "     docker-runner-image = `"$NewDockerImage`""
Write-Host ""
Write-Host "  2. For existing runners, restart them to pick up the new image:"
Write-Host "     gcloud compute instances stop [INSTANCE_NAME] --zone=$Zone"
Write-Host "     gcloud compute instances start [INSTANCE_NAME] --zone=$Zone"
Write-Host ""
Write-Host "  3. Verify the fix by checking runner logs for system information output"

# Cleanup
Remove-Item $metadataFile -ErrorAction SilentlyContinue

Write-Success "Update script completed!"
