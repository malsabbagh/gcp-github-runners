#!/usr/bin/env bash
# Generate ignored operator inputs. Never apply infrastructure or create credentials.
set -euo pipefail
hcl_string() {
  python3 -c 'import json,sys; print(json.dumps(sys.argv[1].replace("${", "$${").replace("%{", "%%{")))' "$1"
}
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
command -v python3 >/dev/null || { echo 'Python 3 is required.' >&2; exit 1; }
cd "$root/terraform"
[[ ! -e terraform.tfvars ]] || { echo 'terraform.tfvars exists; edit it deliberately or move it aside first.' >&2; exit 1; }
read -r -p 'Google Cloud project ID: ' project_id
read -r -p 'Region: ' region
read -r -p 'Zone: ' zone
read -r -p 'GitHub repository owner: ' repository_owner
read -r -p 'GitHub repository name: ' repository_name
read -r -p 'Repository branch: ' repository_branch
read -r -p 'Exact worker image resource (projects/.../global/images/...): ' worker_image
read -r -p 'Builder image pinned to @sha256 digest: ' builder_image
read -r -p 'Existing function deployment builder service account email: ' function_build_service_account
read -r -p 'Path to assembled controller deployment ZIP: ' controller_archive_path
read -r -p 'Numbered webhook Secret Manager version reference: ' webhook_secret_version
read -r -p 'Numbered GitHub App private key Secret Manager version reference: ' github_app_private_key_secret_version
read -r -p 'GitHub App ID: ' github_app_id
read -r -p 'GitHub App installation ID: ' github_app_installation_id
read -r -p 'Verified GitHub repository numeric ID: ' github_repository_id
read -r -p 'Verified repository runner group ID: ' runner_group_id
read -r -p 'Verified numeric administrator OIDC subject: ' admin_subject
for name in project_id region zone repository_owner repository_name repository_branch worker_image builder_image function_build_service_account controller_archive_path webhook_secret_version github_app_private_key_secret_version github_app_id github_app_installation_id github_repository_id runner_group_id admin_subject; do
  [[ -n "${!name}" ]] || { echo "Required input: $name" >&2; exit 1; }
done
umask 077
cat > terraform.tfvars << EOF
project_id = $(hcl_string "$project_id")
region = $(hcl_string "$region")
zone = $(hcl_string "$zone")
repository_owner = $(hcl_string "$repository_owner")
repository_name = $(hcl_string "$repository_name")
repository_branch = $(hcl_string "$repository_branch")
worker_image = $(hcl_string "$worker_image")
builder_image = $(hcl_string "$builder_image")
function_build_service_account = $(hcl_string "$function_build_service_account")
controller_archive_path = $(hcl_string "$controller_archive_path")
webhook_secret_version = $(hcl_string "$webhook_secret_version")
github_app_private_key_secret_version = $(hcl_string "$github_app_private_key_secret_version")
github_app_id = $(hcl_string "$github_app_id")
github_app_installation_id = $(hcl_string "$github_app_installation_id")
github_repository_id = $(hcl_string "$github_repository_id")
runner_group_id = $(hcl_string "$runner_group_id")
admin_subject = $(hcl_string "$admin_subject")
EOF
printf 'Created ignored terraform/terraform.tfvars with restrictive permissions.\nReview it, then run terraform init and terraform plan deliberately. Nothing was deployed.\n'
