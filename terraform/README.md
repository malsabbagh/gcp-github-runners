# Portable one-job runner infrastructure

This root now defines infrastructure for the selected trusted private one-job
Spot VM profile. Local formatting, provider schema validation and mocked plan
tests do not deploy or prove provider readiness.

The root enables required APIs, creates four distinct runtime service accounts,
a named durable Firestore database, a private subnet with Cloud NAT egress, an
exact-image Spot instance template, one Node 24 Gen2 HTTP controller and a paused
OIDC-authenticated recovery scheduler. It defines optional error monitoring.
There are no source webhook Cloud Build triggers, PAT secrets, test VMs,
shared-host workers, time-based cleanup build or separate legacy cleanup function.
Internal Cloud Build remains the asynchronous provisioner, with a dedicated
identity and a builder container pinned by SHA256 digest.

Use Terraform 1.9 or later; the provider is pinned to Google 6.50.0. The committed
lock contains signed package checksum coverage for Linux AMD64 and Darwin ARM64.
The local-only checks are:

```sh
terraform -chdir=terraform fmt -check -recursive
terraform -chdir=terraform init -backend=false -input=false -lockfile=readonly
terraform -chdir=terraform validate
terraform -chdir=terraform test
```

`terraform test` uses a mocked provider and synthetic inputs. No live credentials,
provider state, cloud API requests or cloud infrastructure are used. Its fake
archive fixture must never be deployed. The root's real source input is an
operator-built, screened ZIP referenced by `controller_archive_path`; build it
from a clean committed checkout using `npm run check:archive` followed by
`npm run package:controller -- dist/<fresh-run>/controller`. The latter command
creates and reopens `dist/<fresh-run>/controller.zip`, with package.json at the
archive root, and writes its manifest and revision-bound packaging receipt in
the same parent directory. Use that verified ZIP directly as
`controller_archive_path`; do not ZIP it again or archive the repository/parent
directory. Keep the receipt with the separately collected full qualification
evidence. Existing stage, manifest, ZIP or receipt destinations are refused.

Copy `terraform.tfvars.example` to a local ignored tfvars file or use
`scripts/setup.sh`. Supply the selected project/region/zone and repository,
verified App/installation/repository numeric IDs, numbered existing webhook and
App-key secret-version references, verified operator service-account OIDC
subject, exact native worker image and qualified provisioner image digest.
The sample IDs and all-zero digest are synthetic placeholders, not deployable
artifacts. Worker images must be baked using the tracked native image build
assets before accepting work. If the builder digest is private, set
`builder_image_repository` to its exact Artifact Registry repository. The image
owner must permit the explicit image-user IAM grant if it is in another project.

A separate existing `function_build_service_account` is required for compilation;
it must belong to this project and differ from all runtime accounts. The function
module defines that builder's log-writer grant, source-bucket object viewing,
regional managed staging-source viewing and writer access to its dedicated image
repository. It explicitly configures that repository as `docker_repository`.
These follow the [Cloud Run functions custom build account requirements](https://docs.cloud.google.com/functions/docs/building).
The deployment principal still needs the applicable API/resource administration
permissions and `iam.serviceAccounts.actAs` on the function builder, controller
and scheduler identities; those deployment privileges are not assigned here.
Existing Google-managed Functions, Run, Build and Scheduler service-agent grants,
billing, quotas and organization policy compatibility must be verified before a
separately authorized deployment. No service-account keys are created.

Controller and provisioner Firestore grants are conditional on exactly the
selected database, following Google's [database access conditions](https://docs.cloud.google.com/firestore/native/docs/manage-databases#configure-per-database-access-permissions).
The controller has custom Compute verification/retirement and build-submission
permissions. The provisioner has custom Compute insertion/inspection and build
observation permissions, `actAs` on the worker only, and read access to that
worker account's unique identity. Runtime Compute permissions remain project
scoped; use a dedicated runner project and review all inherited/legacy grants.
Resource-specific grants cover the exact secret resources, boot image and optional
private builder repository. Secret Manager IAM applies to a secret, not one
version; runtime readers use the numbered references and no secret payload is
stored in Terraform variables, state outputs or worker metadata.

Workers receive no project IAM, Firestore, Secret Manager, Compute, `actAs` or
management authority, and their VM account has no OAuth access scopes. The only
worker grant is invocation of the controller transport; the broker requires a
verified metadata identity, exact allocation ownership and VM incarnation.
Cleanup owns only scheduler invocation. GitHub's webhook requires public HTTP
transport, so the controller's Cloud Run service grants `allUsers` invocation.
Public transport does not authenticate a management operation: runtime routes
separately enforce HMAC webhook signatures, worker metadata identities, and
verified operator/scheduler OIDC subjects and audiences.

All `runtime_readiness` flags are false and `scheduler_paused=true` by default.
Review actual SDK, App installation/JIT lifetime, image ownership, negative IAM,
actor quiescence and lifecycle race evidence before opting into any capability.
Neither elapsed time nor an ambiguous CLI failure authorizes charge release.
Retirement preserves uncertain allocations. Provider schema checks do not prove
effective live IAM, organization policy, image existence, token audiences,
service account identity, metadata reachability, egress or deployed readiness.

`terraform output -json infrastructure_config` exposes safe configuration
references, four service account names, worker unique ID, repository/label
routing, template/database names and the canonical `runtime_environment` map.
It also contains compatibility keys for setup/sync scripts. `webhook_url` is the
HMAC-authenticated `/webhook` route; `controller_url` is the management OIDC
audience and `ALLOCATION_BROKER_URL` is the distinct `/bootstrap` audience.
Outputs include environment-specific resource references: keep saved outputs,
tfvars and state outside committed/shared artifacts.

Database deletion protection defaults on, with an abandon policy on destroy;
source buckets are not force-destroyed. No backend is preselected. Choose a
reviewed state backend and plan/apply only under a separate deployment request.
