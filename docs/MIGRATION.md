# Compatibility and supported profiles

The root implementation is the supported trusted-private one-job Spot VM deployment. Public PR validation belongs on GitHub-hosted runners. The compatibility templates are retained for readable reference and isolated offline regression qualification; they are not an alternate deployment path.

| Capability | Supported implementation | Acceptance boundary |
| --- | --- | --- |
| Configuration and deployment | Root Terraform and `scripts/setup*` / `sync-terraform-config*` | Operator supplies identities, immutable images and numbered secret references; local setup does not deploy. |
| Signed scaling and capacity | Raw-byte HMAC, configured numeric repository identity, current private-repository authorization, routing labels and transactional allocation | Public/unproven new demand is rejected before reservations/build submission; waiting replay revalidates current authority. |
| Worker startup and retirement | Allocation-bound App JIT, one unprivileged runner per private VM, controller-owned exact retirement | No management credentials on workers; live IAM/image/JIT/network/lifecycle evidence remains necessary. |
| Contributor validation | Hosted read-only CI, complete regression scope, 81% per-file JavaScript coverage and mocked Terraform tests | Source evidence does not establish a successful deployment or hostile-workload isolation. |
| Optional review automation | Checked-in ReviewSensei caller contract 5.2, setup 5, configuration schema 1 | Canonical `@reviewsensei` and legacy `@sensei` route through the supported `@v5` channel. Automatic reviews/writes/auto-approval/mentions remain configured; egress is disabled and the eight-call budget is retained. Integration is optional and separate from controller deployment; see [repository automation](../.github/README.md). |
| Compatibility templates | `source-compatible/manifest.json` and reference materializer | Non-executable CLI outputs; explicit internal offline-qualification mode retains executable fixtures. No supported legacy operator deployment. |

The [path ledger](migration-map.json) records retained paths, replacements and exclusions. The [behavior matrix](../source-compatible/behavior-matrix.json) distinguishes template integrity, adaptations and inherited defects. Endpoint validation, safe hosted examples, license metadata and reference-only materialization are deliberate adaptations; unchanged-file counts do not describe the final security boundary.

Each retained template has a current digest. Existing historical source-digest fields remain evidence, while new project helpers are identified as adaptations. Root MIT license and notice bytes are included in generated distributions. No third-party dependency is relicensed by the project notice.

Old materialized directories are not rewritten. Regenerate a reference with `--purpose reference`; use the root supported route for deployment. Historical waiting-demand records lacking the required numeric repository/private context remain preserved and ineligible for new provisioning until an operator reconciles them. Drain a live workload deployment before changing its repository visibility; uncertain resources are never deleted just to satisfy a transition.

Current-file endpoint removal does not erase Git history or cached PR content. Publication review must inspect those surfaces separately. Seven known dependency alerts remain accepted follow-up work, not fixed vulnerabilities or a blanket security clearance.
