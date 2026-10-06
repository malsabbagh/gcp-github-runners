# Required functionality migration

The attribution-corrected initial snapshot `e130e62d445a08ef4987be26fcc4538a0e3ddcd3` contained the approved 75-file subset. Matching that manifest established delivery of the prepared subset; it did not establish full source functionality.

The restoration audit compares all 195 paths in the union of frozen source `main` (`acbf72d91108fa6c2c4e911129e60fe7912b5c1b`) and selected PR #25 (`301ff51b8cb6493b2bb2c60b55b04586200c73eb`). The initial comparison found 167 absent, 25 modified and 3 identical source paths, plus 47 destination adaptations. Generated coverage, private operations material and unsupported variants are included in those counts; an absent path is not automatically a missing supported feature.

[The machine-readable ledger](migration-map.json) records every source path, original snapshot status, current disposition, replacement paths and their presence. It copies paths and classification only, not private source contents. Presence establishes implementation inventory; test and scan evidence establish bounded correctness/privacy separately.

## Supported requirements

| Requirement | Current implementation/replacement | Acceptance boundary |
|---|---|---|
| Portable configuration, setup and outputs | Terraform variables/resources/examples and `scripts/setup*`, `sync-terraform-config*` | Local setup is nondeploying; operator supplies actual project, images, identities and numbered secret references |
| Signed workflow-job scaling, deduplication, capacity, cancellation | Webhook runtime, Firestore allocation coordinator, asynchronous provisioner, actual-job association and bounded canonical waiting-demand retry | One job per disposable VM; actual provider behavior and load/latency require target qualification |
| Worker registration, startup, shutdown and cleanup | Allocation-bound GitHub App JIT broker, native one-job worker/service/control, controller-owned once-only stop/retirement with provider readback | Worker gets no management credentials; identity, JIT lifetime, image and retirement live acceptance remain required |
| Deployment infrastructure and IAM | Canonical Terraform controller, named Firestore, private Spot template/network, distinct runtime identities and authenticated scheduler | Resource syntax/plan fixtures do not prove effective permissions or authorize apply |
| Image/build tooling | Native Packer image profile and pinned provisioning-builder interface | Actual image build/provenance, private egress and workload tools remain operator inputs |
| Deterministic contributor validation | Restored CI, built-in Node suites, both full Jest suites, all Python suites with fail-on-skips, script/provider validation, 81% per production JavaScript file across all four metrics | No provider key or ReviewSensei dependency; fixtures do not prove live deployment |
| Optional ReviewSensei | Restored review/uninstall workflows, `.reviewsensei.yml`, automation guide | Manual/advisory, publication/automatic review/mentions/egress disabled; App/broker/OIDC/provider activation separate |
| Usage, monitoring and uninstall | Portable job examples, optional Terraform error alerts and signal guidance, fenced management and destroy-plan tooling, current docs | No private job-owned management tokens; cleanup preserves uncertain/busy capacity |

## Deliberate exclusions

The selected architecture supersedes eight-job batching, shared-host multi-user/Docker modes and the competing direct Cloud Build webhook deployment. Hybrid cleanup, orphan lifecycle packages and disabled/backup Terraform routes do not remain parallel authorities. Portable native image, durable recovery and exact retirement preserve the selected useful behavior while changing unsupported legacy interfaces.

Generated coverage/HTML, logs, temporary state, credential-bearing `.env` configuration, private operational reports and imported source ancestry remain excluded. Generic current documentation replaces historical success reports; their claims are not carried forward. Historical age/offline bulk runner deletion and state-clearing tools are replaced by fenced authenticated controller operations.

## What completeness means

The ledger must cover all 195 compared paths and resolve every required feature to an existing selected-profile implementation, portable replacement, or a justified unsupported/private/generated exclusion. It must not turn historical issue closure, snapshot equality or a count of passed fixtures into a live readiness claim.

Remaining installation work is concrete: authorize target resources, qualify/build immutable images, supply existing external secret references and GitHub App configuration, demonstrate effective IAM/network/JIT/lifecycle properties in a disposable test, then enable only proven controls. Repository Actions and optional ReviewSensei activation are separate operator decisions. Public release also requires resolving the missing source root license/copyright notice described in [NOTICE.md](../NOTICE.md).
