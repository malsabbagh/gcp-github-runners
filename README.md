# GCP GitHub runners

A portable controller for one GitHub Actions job per disposable Google Cloud Spot VM. Authenticated repository webhooks create durable Firestore demand and capacity reservations; an asynchronous provisioner starts private workers, and a controller reconciles uncertain outcomes and retires exact worker incarnations.

The repository restores the selected source functionality with sanitized portable configuration, infrastructure modules, image tooling, operator scripts, CI and optional ReviewSensei tooling. The supported architecture supersedes shared-host batching and the competing direct Cloud Build webhook route. [The migration ledger](docs/MIGRATION.md) records every compared source path and its replacement or deliberate exclusion.

## Start here

Use Node 24, npm, Python 3, Bash and PowerShell for the complete local regression suite. Terraform 1.9.8 validates the infrastructure; Packer is needed only for image qualification/building.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

CI includes the built-in Node fixtures, both full Jest suites, all Python regression directories, script syntax and Terraform validation. See [test instructions](TEST_SCRIPTS_README.md) for individual commands, coverage limits and tools. Successful fixtures and static checks are source evidence; they do not establish live IAM, images, GitHub installation or end-to-end runner qualification.

For installation, read [deployment instructions](DEPLOYMENT.md), [architecture](ARCHITECTURE.md), [cleanup](CLEANUP_SCRIPTS_README.md) and [job routing](docs/JOB_USAGE.md), [native image tooling](docs/WORKER_IMAGE.md) and [monitoring](docs/MONITORING.md). Setup generates ignored operator inputs; Terraform owns infrastructure deployment. Local testing does not require cloud credentials.

## Repository readiness

The migration has not enabled repository Actions, provisioned provider secrets, installed a ReviewSensei broker/App, created cloud resources, built an image, archived the original repository or changed repository visibility. Those are explicit operator steps. Destructive lifecycle and JIT/bootstrap qualification controls remain disabled by default until the target environment has passed the acceptance steps in [deployment instructions](DEPLOYMENT.md).

Optional [ReviewSensei automation](.github/README.md) is present with manual invocation, advisory reviews, publication disabled and provider egress disabled. Cloud Ollama requires an explicit egress decision and provider authorization before it can run.

Package metadata declares MIT; the selected source did not contain a root license or copyright notice. [NOTICE.md](NOTICE.md) records that limitation without inventing a copyright assignment.
