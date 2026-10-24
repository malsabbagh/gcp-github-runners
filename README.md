# GCP GitHub runners

A portable controller for one GitHub Actions job per disposable Google Cloud Spot VM. Authenticated repository webhooks create durable Firestore demand and capacity reservations; an asynchronous provisioner starts private workers, and a controller reconciles uncertain outcomes and retires exact worker incarnations.

The supported deployment uses trusted private workload repositories. Public pull-request validation uses GitHub-hosted runners. Infrastructure modules, image tooling and operator scripts have separate activation requirements. [Compatibility boundaries](docs/MIGRATION.md) distinguish the supported controller from retained offline reference material.

## Start here

Use Node 24, npm, Python 3, Bash and PowerShell for the complete local regression suite. Terraform 1.9.8 validates the infrastructure; Packer is needed only for image qualification/building.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

CI includes the built-in Node fixtures, both full Jest suites, all Python regression directories, script syntax and Terraform validation. See [test instructions](TEST_SCRIPTS_README.md) for individual commands, coverage limits and tools. Successful fixtures and static checks are source evidence; they do not establish live IAM, images, GitHub installation or end-to-end runner qualification.

For installation, read [deployment instructions](DEPLOYMENT.md), [architecture](ARCHITECTURE.md), [cleanup](CLEANUP_SCRIPTS_README.md) and [job routing](docs/JOB_USAGE.md), [native image tooling](docs/WORKER_IMAGE.md) and [monitoring](docs/MONITORING.md). Setup generates ignored operator inputs; Terraform owns infrastructure deployment. Local testing does not require cloud credentials.

## Repository readiness

Repository visibility, Actions activation, provider authorization, App installation, image building and cloud deployment are separate operator steps. The presence of workflow files does not establish that automation is enabled. Destructive lifecycle and JIT/bootstrap qualification controls remain disabled by default until the target environment has passed the acceptance steps in [deployment instructions](DEPLOYMENT.md).

Maintainer automation, including optional ReviewSensei reviews and coverage publication, is documented in [repository automation](.github/README.md). It is separate from the runner controller and cloud deployment.

Copyright (c) 2026 Mohamad Alsabbagh. This project is licensed under [MIT](LICENSE); [third-party notices](NOTICE.md) continue to apply. Seven known dependency alerts remain deferred for follow-up; this release does not claim that they are fixed.

## Offline compatibility references

The [compatibility reference](source-compatible/README.md) retains older handlers, worker variants and operator tools for inspection and isolated regression qualification. It is not a supported deployment profile. Privileged, shared-host and worker-credential variants must not run public PRs or hostile jobs. Use the root one-job deployment for trusted private workloads.
