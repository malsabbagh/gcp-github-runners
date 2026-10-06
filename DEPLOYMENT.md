# Deployment and operator setup

This guide describes the supported installation path. The migration work did not execute cloud deployment, live IAM changes, image creation, webhook registration, App installation or repository Actions activation.

## Required operator inputs

Choose an independently authorized Google Cloud project and region/zone. Terraform creates the dedicated private network/subnet/NAT, named Firestore database and distinct controller/provisioner/scheduler/worker identities. Supply an existing separately authorized function-build identity. Review those resources and IAM grants before applying them, including the approved egress route to GitHub and the controller. The worker needs private connectivity and an allocation broker invocation route; management credentials stay on the controller.

Choose an exact prequalified worker image resource and an immutable provisioning builder image digest. Supply the function-build service account, repository owner/name/branch, numeric GitHub repository/App/installation/runner-group IDs, a dedicated runner routing label, registered/required label lists, and the verified administrator invocation subject.

Secrets are external inputs. Configure numbered Secret Manager version references for the webhook HMAC secret and GitHub App private key. Never place secret payloads, PATs, private keys or provider API keys in Terraform variables, Git, images, logs or deployment archives. The GitHub App must be independently installed on the intended repository with the permissions required by the runner adapter.

## Prepare and validate locally

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run check:archive
npm run package:controller
bash scripts/setup.sh
terraform -chdir=terraform fmt -check -recursive
terraform -chdir=terraform init -backend=false -input=false -lockfile=readonly
terraform -chdir=terraform validate -no-color
```

`setup.sh`, `setup-clean.sh` and the PowerShell setup wrapper generate ignored `terraform/terraform.tfvars` with restrictive permissions and refuse to overwrite existing configuration. They do not create credentials, initialize Terraform, plan or apply. Alternatively, copy and edit the sanitized `terraform.tfvars.example`. Check every input against [terraform/README.md](terraform/README.md).

The packaging command creates `dist/controller/`, `dist/controller-manifest.json` and `dist/controller.zip` from the declared closure and deployment lock. It reopens the actual ZIP and verifies canonical entry paths, original bytes, SHA-256 hashes and Unix modes while rejecting extra/symlink entries; the command reports the archive SHA-256. Supply that ZIP path as `controller_archive_path`. It refuses an existing assembly directory rather than overwriting it. Preserve the manifest and receipt with the installation evidence; packaging does not deploy or bundle ambient operator files. Do not archive the repository root or add local configuration/state. Validate/build the worker using the [native image tooling](docs/WORKER_IMAGE.md); building a cloud image is a separate authorized operation.

## Apply only after operator authorization

Initialize the intended backend and inspect a saved Terraform plan in the target project. Confirm identity separation, service-account attachment, numbered secret references, private networking, ingress and authenticated management routes. Terraform is the canonical deployment owner; do not deploy the historical webhook subdirectory independently.

After an approved apply, the configuration exporter reads `infrastructure_config.runtime_environment`:

```sh
bash scripts/sync-terraform-config.sh
# PowerShell equivalent
pwsh -File scripts/sync-terraform-config.ps1
```

The exporter writes ignored mode-0600 `.env.terraform` (or `.env.terraform.ps1`) and `.env.terraform.yaml` files containing configuration and secret references only. It does not deploy. `--deploy`/`-Deploy` is rejected to prevent a second deployment route.

Webhook registration is also an explicit operator action:

```sh
bash scripts/setup-webhook.sh
# PowerShell equivalent
pwsh -File scripts/setup-webhook.ps1
```

These scripts read Terraform's webhook URL, prompt for the existing HMAC secret and use authenticated GitHub tooling to configure a `workflow_job` webhook. They do not create/copy a cloud secret. Before registration, verify that public webhook ingress accepts only the intended signed payload route and that bootstrap/management requests independently enforce their identity and audience checks. Preserve the configured controller audience/base path: the default broker URL is `<controller-url>/bootstrap`, and outbound worker control uses that broker base plus `/worker-control/poll` or `/worker-control/ack`. The deployment adapter validates broker/controller origin and base-path consistency; do not rewrite the broker to an unrelated root URL.

## Acceptance before enabling lifecycle controls

Use a disposable trusted-repository test job with the exact required labels. Record each allocation's expected job/run/attempt, reservation, build, instance numeric ID, runner ID, registered labels and completion evidence through secure operator tooling. Verify duplicate delivery, cancellation before/after submission, uncertain submission, worker identity mismatch, restart containment, actual-job association, scheduler retries and retirement without prematurely freeing capacity.

Prove that the worker cannot read management secrets, mutate authoritative Firestore allocation state or invoke Compute management APIs. Verify the actual private networking, GitHub App/JIT behavior and lifetime, IAM impersonation boundaries, shutdown/control transport and post-delete cloud absence. Enable qualification controls only for properties the target environment has demonstrated. Busy workers and ambiguous instances must remain charged.

Enable GitHub Actions separately if wanted; the restored CI itself has no deployment authority. ReviewSensei additionally requires approved broker/App/OIDC authorization and provider policy/key configuration; [automation instructions](.github/README.md) document its manual, advisory defaults.

## Removal

Stop admission and scheduler invocation deliberately, retain state needed to reconcile active/uncertain workers, and retire exact owned instances through the controller. Confirm no charged allocations or managed workers remain before preparing and inspecting a Terraform destroy plan with `bash scripts/destroy-resources.sh`. This helper creates ignored `terraform/destroy.tfplan` and never applies it. Do not delete state records to manufacture capacity or use age-only runner/VM deletion. Remove the independently installed GitHub webhook/App and external credentials through the authorized operator channels after verifying no active dependency remains.
