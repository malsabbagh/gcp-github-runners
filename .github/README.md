# Repository automation

Public pull-request validation uses GitHub-hosted Ubuntu runners and read-only repository tokens. Checkout credentials are not persisted. Tests receive no cloud/provider secret or OIDC deployment authority. Root CI runs the Node 24 fixture/Jest/Python suites, the per-production-JavaScript-file 81% coverage gate, syntax checks, archive checks, and Terraform validation/mocked tests. Python qualification requires PowerShell and treats skipped suites as failures.

Source-compatible CI materializes an isolated offline qualification tree with synthetic inputs. Its tests retain the separate checked-in dependency locks. A separate `publish-coverage` job receives `contents: write` only after successful validation on a push to `main`. It downloads coverage from that same run and publishes it to the coverage branch without executing the report contents. PR runs cannot invoke this publisher or provide its input artifact. Coverage publication does not enable a Pages site by itself.

`terraform init -backend=false` installs pinned providers without accessing backend state; validation and mocked tests do not deploy. A green test result does not qualify live IAM, images, networking, JIT lifetime or hostile-workload isolation. Repository visibility does not require enabling Actions.

## ReviewSensei policy and activation

ReviewSensei is optional maintainer automation for this repository. It is not part of the GCP runner controller, controller archive or Terraform deployment, and installing or deploying the runner does not require it. Deterministic CI runs independently of ReviewSensei.

The checked-in `.reviewsensei.yml` enables automatic reviews, GitHub publication, auto-approval and authorized mentions. It disables provider data egress, learning and review artifacts. It is not a manual-only or advisory-only configuration. The workflow handles eligible PR events, authorized issue/inline mentions, commands, replies and manual dispatch while resolving a frozen PR identity from the trusted default branch.

The root configuration uses schema `1`; the setup marker is version `5`; the caller interface is contract `5.2`. The caller supports canonical `@reviewsensei` and legacy `@sensei` mentions. Standalone rescan and remaining-review requests resolve only the current PR head (or a matching prefix); command routing is a syntax prefilter, with execution authorization enforced by the runtime and broker. Manual remaining-review is available, defaulting to false. Optional manual publication-recovery inputs are not enabled.

The caller grants a read-only repository token plus OIDC authority to its external reusable workflow, and explicitly maps the existing provider secret names. Publication depends on the broker/App's independent authorization. Keep the supported `@v5` workflow channel: the broker validates the accepted tag and its resolved executing SHA. Substituting an arbitrary commit ref is not a compatible caller upgrade. The alignment reference is released v5 source `c80d19837f7bc3ac90a54fb8184638443628b7b6`, core `0.8.12` and hosted adapter `0.3.13`; this records source compatibility, not the runtime installed in a particular consumer or live broker acceptance.

GCP retains its selected cloud backend/model, 900-second timeout and eight-call budget. `github.operation_entry: enabled` makes the packaged default explicit. Publication inventory and review-work mode retain their packaged `legacy` defaults. The upstream repository's opt-in `complete` inventory and `unified` mode are separate policy choices, not required schema upgrades. Enabling them requires exact-package validation and compatible-reader evidence for every active or delayed consumer/finalizer before merging into trusted main. Local source checks alone cannot establish that inventory.

Before activating this automation, review the external workflow and approve the App/broker/OIDC policy and provider egress separately. Local resolver tests do not establish those guarantees. This alignment changes no permissions, secret bindings, runner selection, App installation, broker settings or provider egress, and enables no workflow. Actual repository activation and consumer reader compatibility remain unverified.

The manual removal workflow creates a cleanup branch, removes setup files, commits, pushes and opens a PR when deliberately invoked. It uses the existing public `malsabbagh` noreply Git identity. Its offline regressions use a temporary Git tree and intercept remote operations.

Enabling repository Actions can activate checked-in automatic workflows. Keep activation pending until these requirements and the public-fork policy are reviewed; the current enabled/disabled status must be checked independently as a repository setting.
