#!/usr/bin/env bash
# Reviewable Terraform destroy plan only; no cloud deletion is executed.
set -euo pipefail
[[ $# -eq 0 ]] || { echo 'This command only prepares a destroy plan and accepts no arguments.' >&2; exit 1; }
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
umask 077
terraform -chdir="$root/terraform" plan -destroy -out=destroy.tfplan
echo 'Prepared ignored terraform/destroy.tfplan. Review ownership, active workers and retained data before separately approving/applying it.'
