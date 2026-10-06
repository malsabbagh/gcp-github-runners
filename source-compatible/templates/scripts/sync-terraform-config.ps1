# Generate Cloud Function configuration from Terraform outputs
# This script should be run from the terraform directory after applying Terraform

param(
    [switch]$Deploy = $false
)

Write-Host "🔧 Generating Cloud Function configuration from Terraform outputs..." -ForegroundColor Blue

# Check if we're in the terraform directory
if (-not (Test-Path "main.tf")) {
    Write-Host "❌ Error: This script must be run from the terraform directory" -ForegroundColor Red
    exit 1
}

# Get Terraform outputs
Write-Host "📋 Reading Terraform outputs..." -ForegroundColor Yellow
try {
    $infrastructureConfig = terraform output -json infrastructure_config | ConvertFrom-Json
    
    if (-not $infrastructureConfig) {
        throw "No infrastructure config output found"
    }
    
    $projectId = $infrastructureConfig.project_id
    $zone = $infrastructureConfig.zone
    $instanceTemplateName = $infrastructureConfig.instance_template_name
    $maxRunnerVMs = $infrastructureConfig.max_runner_vms
    $runnerCount = $infrastructureConfig.runner_count
    $webhookHandlerServiceAccount = $infrastructureConfig.webhook_handler_service_account
    $requiredRunnerLabelsB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject @($infrastructureConfig.required_runner_labels) -Compress)))
    $cloudbuildServiceAccount = $infrastructureConfig.cloudbuild_service_account
    $repoOwner = $infrastructureConfig.github_repo_owner
    $repoName = $infrastructureConfig.github_repo_name
    $machineType = $infrastructureConfig.machine_type
    
    Write-Host "📝 Configuration values from Terraform:" -ForegroundColor Green
    Write-Host "  Project ID: $projectId"
    Write-Host "  Zone: $zone"
    Write-Host "  Instance Template: $instanceTemplateName"
    Write-Host "  Max VMs: $maxRunnerVMs"
    Write-Host "  Runners per VM: $runnerCount"
    Write-Host "  Machine Type: $machineType"
    
    # Generate environment variables for Cloud Function deployment
    $envVars = "GOOGLE_CLOUD_PROJECT=$projectId,DEFAULT_ZONE=$zone,INSTANCE_TEMPLATE_NAME=$instanceTemplateName,MAX_RUNNER_VMS=$maxRunnerVMs,RUNNERS_PER_VM=$runnerCount,MACHINE_TYPE=$machineType,GITHUB_WEBHOOK_SECRET_NAME=github-webhook-secret,GITHUB_REPO_OWNER=$repoOwner,GITHUB_REPO_NAME=$repoName,CLOUDBUILD_SERVICE_ACCOUNT=$cloudbuildServiceAccount,REQUIRED_RUNNER_LABELS_B64=$requiredRunnerLabelsB64,ENABLE_SELF_HOSTED=true,LOG_EXECUTION_ID=true"
    
    Write-Host ""
    Write-Host "🚀 Environment variables for Cloud Function deployment:" -ForegroundColor Cyan
    Write-Host $envVars
    
    # Save to a file for reference
    $envFileContent = @"
# Generated from Terraform outputs on $(Get-Date)
# To use these values in PowerShell, run: . .\.env.terraform.ps1

`$env:GOOGLE_CLOUD_PROJECT="$projectId"
`$env:DEFAULT_ZONE="$zone"
`$env:INSTANCE_TEMPLATE_NAME="$instanceTemplateName"
`$env:MAX_RUNNER_VMS="$maxRunnerVMs"
`$env:RUNNERS_PER_VM="$runnerCount"
`$env:MACHINE_TYPE="$machineType"
`$env:GITHUB_WEBHOOK_SECRET_NAME="github-webhook-secret"
`$env:GITHUB_REPO_OWNER="$repoOwner"
`$env:GITHUB_REPO_NAME="$repoName"
`$env:CLOUDBUILD_SERVICE_ACCOUNT="$cloudbuildServiceAccount"
`$env:REQUIRED_RUNNER_LABELS_B64="$requiredRunnerLabelsB64"
`$env:ENABLE_SELF_HOSTED="true"
`$env:LOG_EXECUTION_ID="true"

# For gcloud deployment
`$env:CLOUD_FUNCTION_ENV_VARS="$envVars"
"@
    
    $envFileContent | Out-File -FilePath "../cloud-functions/webhook-handler/.env.terraform.ps1" -Encoding UTF8
    
    Write-Host ""
    Write-Host "💾 Environment variables saved to ../cloud-functions/webhook-handler/.env.terraform.ps1" -ForegroundColor Green
    
    if ($Deploy) {
        Write-Host ""
        Write-Host "🚀 Deploying Cloud Function with Terraform configuration..." -ForegroundColor Blue
        
        Set-Location "../cloud-functions/webhook-handler"
        
        $deployCommand = @(
            "gcloud", "functions", "deploy", "webhook-handler",
            "--gen2",
            "--runtime=nodejs20",
            "--source=.",
            "--service-account=$webhookHandlerServiceAccount",
            "--entry-point=webhookHandler",
            "--trigger-http",
            "--allow-unauthenticated",
            "--region=us-central1",
            "--set-env-vars=$envVars"
        )
        
        & $deployCommand[0] $deployCommand[1..($deployCommand.Length - 1)]
        
        if ($LASTEXITCODE -eq 0) {
            Write-Host "✅ Cloud Function deployed successfully with Terraform configuration!" -ForegroundColor Green
        }
        else {
            Write-Host "❌ Cloud Function deployment failed!" -ForegroundColor Red
            exit 1
        }
    }
    else {
        Write-Host ""
        Write-Host "🚀 To deploy the Cloud Function with these settings, run:" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "cd ../cloud-functions/webhook-handler" -ForegroundColor White
        Write-Host "gcloud functions deploy webhook-handler \\" -ForegroundColor White
        Write-Host "  --gen2 \\" -ForegroundColor White
        Write-Host "  --runtime=nodejs20 \\" -ForegroundColor White
        Write-Host "  --source=. \\" -ForegroundColor White
        Write-Host "  --service-account=$webhookHandlerServiceAccount \\" -ForegroundColor White
        Write-Host "  --entry-point=webhookHandler \\" -ForegroundColor White
        Write-Host "  --trigger-http \\" -ForegroundColor White
        Write-Host "  --allow-unauthenticated \\" -ForegroundColor White
        Write-Host "  --region=us-central1 \\" -ForegroundColor White
        Write-Host "  --set-env-vars=`"$envVars`"" -ForegroundColor White
        Write-Host ""
        Write-Host "Or run this script with -Deploy flag to deploy automatically" -ForegroundColor Yellow
    }
    
    Write-Host ""
    Write-Host "✅ Configuration sync complete!" -ForegroundColor Green
    
}
catch {
    Write-Host "❌ Error: Could not read Terraform outputs. Make sure 'terraform apply' has been run." -ForegroundColor Red
    Write-Host "Error details: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
