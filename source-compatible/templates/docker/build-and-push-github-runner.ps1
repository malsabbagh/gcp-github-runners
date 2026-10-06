param(
    [Parameter(Mandatory = $false)]
    [string]$ProjectId,
    
    [Parameter(Mandatory = $false)]
    [string]$Location = "us-central1",
    
    [Parameter(Mandatory = $false)]
    [string]$RustTag = "stable",
    
    [Parameter(Mandatory = $false)]
    [string]$DockerfilePath = "Dockerfile.rust",
    
    [Parameter(Mandatory = $false)]
    [switch]$SkipRepoCreation,
    
    [Parameter(Mandatory = $false)]
    [switch]$Force
)

# Color functions for better output
function Write-Success { param($Message) Write-Host "✅ $Message" -ForegroundColor Green }
function Write-Info { param($Message) Write-Host "ℹ️  $Message" -ForegroundColor Cyan }
function Write-Warning { param($Message) Write-Host "⚠️  $Message" -ForegroundColor Yellow }
function Write-Error { param($Message) Write-Host "❌ $Message" -ForegroundColor Red }

Write-Info "Building enhanced Rust GitHub runner with disk space optimizations..."
Write-Info "This image includes:"
Write-Info "  • Proper user permissions for Cargo/Rust tools"
Write-Info "  • Pre-job and post-job cleanup mechanisms"
Write-Info "  • Optimized environment variables for efficient builds"
Write-Info "  • Automatic cache cleanup to prevent disk space issues"

# Check prerequisites
function Test-Prerequisites {
    Write-Info "Checking prerequisites..."
    
    if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
        Write-Error "gcloud CLI not found. Please install Google Cloud CLI first."
        exit 1
    }
    
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Write-Error "Docker not found. Please install Docker first."
        exit 1
    }
    
    # Ensure DockerfilePath is set to default if empty after param validation
    if (-not $DockerfilePath -or $DockerfilePath.Trim() -eq "") {
        $DockerfilePath = "Dockerfile.rust"
    }

    # Only try to resolve if DockerfilePath is still not empty
    if ($DockerfilePath -and -not (Test-Path "$DockerfilePath")) {
        $scriptDir = $PSScriptRoot
        if (-not $scriptDir) {
            $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
        }
        $resolvedPath = Join-Path $scriptDir "$DockerfilePath"
        if (Test-Path "$resolvedPath") {
            $DockerfilePath = $resolvedPath
        }
    }

    if (-not $DockerfilePath -or -not (Test-Path $DockerfilePath)) {
        Write-Error "Dockerfile not found at: $DockerfilePath"
        exit 1
    }
    
    Write-Success "Prerequisites check passed"
}

# Validate parameters
if (-not $ProjectId) {
    $ProjectId = Read-Host "Enter your GCP Project ID"
}

if (-not $ProjectId -or $ProjectId.Trim() -eq "") {
    Write-Error "Project ID is required"
    exit 1
}

# Variables
$ghcrCacheRepo = "ghcr-runner-cache"
$customRepo = "github-runner-images"
$customImage = "github-runner-rust:$RustTag"
$artifactImage = "$Location-docker.pkg.dev/$ProjectId/$customRepo/github-runner-rust:$RustTag"

Write-Info "Configuration:"
Write-Host "  Project ID: $ProjectId"
Write-Host "  Location: $Location"
Write-Host "  Rust Tag: $RustTag"
Write-Host "  Dockerfile: $DockerfilePath"
Write-Host "  Target Image: $artifactImage"
Write-Host ""

Test-Prerequisites

# Function to check if repository exists
function Test-ArtifactRepository {
    param($RepoName, $ProjectId, $Location)
    try {
        $null = gcloud artifacts repositories describe $RepoName --location=$Location --project=$ProjectId --format="value(name)" 2>$null
        return $true
    }
    catch {
        return $false
    }
}

# Function to create repository with existence check
function New-ArtifactRepository {
    param($RepoName, $ProjectId, $Location, $Description, $IsRemote = $false)
    
    if (Test-ArtifactRepository -RepoName $RepoName -ProjectId $ProjectId -Location $Location) {
        Write-Warning "Repository '$RepoName' already exists, skipping creation"
        return
    }
    
    Write-Info "Creating repository: $RepoName"
    try {
        if ($IsRemote) {
            gcloud artifacts repositories create $RepoName `
                --project=$ProjectId `
                --repository-format=docker `
                --location=$Location `
                --description=$Description `
                --mode=remote-repository `
                --remote-repo-config-desc="GitHub Container Registry" `
                --disable-vulnerability-scanning `
                --remote-docker-repo="https://ghcr.io" --quiet
        }
        else {
            gcloud artifacts repositories create $RepoName `
                --project=$ProjectId `
                --repository-format=docker `
                --location=$Location `
                --description=$Description --quiet
        }
        Write-Success "Repository '$RepoName' created successfully"
    }
    catch {
        Write-Error "Failed to create repository '$RepoName': $_"
        exit 1
    }
}

if (-not $SkipRepoCreation) {
    Write-Host "`n=== 1. Create remote-cache repo for GHCR ==="
    New-ArtifactRepository -RepoName $ghcrCacheRepo -ProjectId $ProjectId -Location $Location -Description "Cache for GitHub Container Registry images" -IsRemote $true
}
else {
    Write-Info "Skipping repository creation as requested"
}

Write-Host "`n=== 2. Configure Docker to use GCP credentials ==="
try {
    gcloud auth configure-docker "$Location-docker.pkg.dev" --quiet
    Write-Success "Docker authentication configured"
}
catch {
    Write-Error "Failed to configure Docker authentication: $_"
    exit 1
}

Write-Host "`n=== 3. Build your Rust-ready runner image ==="
Write-Info "Building image: $customImage from $DockerfilePath"
try {
    $dockerfileDir = Split-Path -Parent $DockerfilePath
    if (-not $dockerfileDir) { $dockerfileDir = "." }
    docker build -t $customImage -f $DockerfilePath $dockerfileDir
    if ($LASTEXITCODE -ne 0) { throw "Docker build failed" }
    Write-Success "Image built successfully: $customImage"
}
catch {
    Write-Error "Failed to build image: $_"
    exit 1
}

if (-not $SkipRepoCreation) {
    Write-Host "`n=== 4. Create a standard repo for your custom image ==="
    New-ArtifactRepository -RepoName $customRepo -ProjectId $ProjectId -Location $Location -Description "Standard repo for custom GitHub Actions runner images"
}

Write-Host "`n=== 5. Tag & push your custom image ==="
try {
    Write-Info "Tagging image: $customImage -> $artifactImage"
    docker tag $customImage $artifactImage
    if ($LASTEXITCODE -ne 0) { throw "Docker tag failed" }
    
    Write-Info "Pushing image to Artifact Registry..."
    docker push $artifactImage
    if ($LASTEXITCODE -ne 0) { throw "Docker push failed" }
    
    Write-Success "Image pushed successfully to: $artifactImage"
}
catch {
    Write-Error "Failed to tag/push image: $_"
    exit 1
}

Write-Host "`n=== 6. Use your cached, Rust-ready runner ==="
Write-Success "Setup complete! Your Rust GitHub runner is ready."
Write-Host "`nTo pull and run your image on any GCP VM or GKE node:" -ForegroundColor Yellow
Write-Host "docker pull $artifactImage" -ForegroundColor Cyan
Write-Host "docker run -e GH_ORG=<your-org> -e GH_ACCESS_TOKEN=<token> $artifactImage" -ForegroundColor Cyan

Write-Host "`nFor your multi-user runner script, use this image:" -ForegroundColor Yellow
Write-Host "DOCKER_RUNNER_IMAGE=`"$artifactImage`"" -ForegroundColor Cyan
