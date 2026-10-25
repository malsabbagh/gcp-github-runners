# Operator qualification packet

This packet prepares a bounded trusted-private, native Linux x64 runner trial. It records inputs, evidence, stop conditions and unresolved work; it does not perform a build, deployment, registration, job, cancellation or cleanup. Completing [issue #54](https://github.com/malsabbagh/gcp-github-runners/issues/54) does not complete #48 or #49, authorize #55, or establish production readiness.

The checked-in [plan and worksheet](../deployment/qualification-plan.json) select merged main `72592e241eb42579faf6d6024ddaca4ce234d323`, tree `3d4870be1da0afbd5599741a32052a56c2d1093b`. All six SHA-256 bindings match files from that exact commit: controller/archive and dependency manifests, worker-image source contract, runner release and readiness adapter. [Main CI 40161487236](https://github.com/malsabbagh/gcp-github-runners/actions/runs/40161487236) checked out that revision and passed source qualification; it supplies the selected source-contract evidence. The separately bound [case inventory](../tests/qualification-cases.json) uses the same commit/tree. A reviewed lock update must select a new independently verified revision, refresh its bindings and obtain evidence for it; changing a digest under an old commit does not qualify the resulting mixture. Original `bd700664` evidence is retained separately as historical source evidence. PR61 and PR62 are merged ancestors of the selected source; their older receipts keep their own revision scope. Supplying `--source-root` relocates the exact bound source bytes and does not select a different revision.

## Preparation and readiness reports

The [offline validator](../tests/qualification/packet.py) reads JSON and the selected local source files, then prints a report to stdout. It has no network client, subprocess, execution mode, credential generator or activation facility. It neither fetches evidence references nor verifies their authorship, approvals, freshness or truth. An operator must inspect and attest those records independently. Reports always contain `execution_authorized: false`.

From the repository root, check structural preparation against the independently verified source identity:

```sh
python3 -B tests/qualification/packet.py \
  --source-commit 72592e241eb42579faf6d6024ddaca4ce234d323 \
  --source-tree 3d4870be1da0afbd5599741a32052a56c2d1093b \
  --mode preparation
```

Preparation returns success when the records are structurally complete even with explicit pending or held prerequisites. Inspect the operation reports: the checked-in worksheet leaves every live operation unavailable. Null deployment/image identities are deliberate unknowns, not tested placeholders.

For a private worksheet copy, add `--plan /absolute/path/to/reviewed-plan.json`. `--source-root` may select a local snapshot of the independently attested source. Supplied `--source-root`, `--plan` and `--cases` paths must be canonical absolute paths with no symlink in the supplied path or its ancestry. Select the canonical nonsymlinked directory/files explicitly. The validator gives an option-specific issue and guidance before reading input contents; it does not silently resolve supplied aliases or relax rejection of symlinked descendants.

> Operator-controlled input files and directories must remain unchanged throughout validation. Preflight symlink checks are not atomic protection against concurrent path swaps; descriptor-based protection against an adversary changing those paths during validation is outside this report-only validator's scope.

To check a single operation's submitted evidence, use the same arguments with `--mode operation-ready --operation job`. The five operation names are `image-build`, `controller-install`, `job`, `cancellation-recovery` and `cleanup`. This mode returns failure for placeholders, absent evidence, mismatched revisions/manifest bytes, unresolved required prerequisites, disabled required flags or incomplete worksheet fields. It reports evidence availability; success is not permission to execute. Unknown worksheet field names are rejected by field validation. Evidence locations and observation references retain their existing opaque-string semantics; they gain no new URI format rules or fetching behavior.

A required prerequisite with status `pending`, `held` or `deferred` makes its operation unavailable. Deferral is never a readiness waiver. Satisfied records require a concrete reference of the expected source, live or decision scope, bound to the selected commit and tree. Source tests cannot stand in for a live observation. The optional broad fault campaign is explicitly deferred; no campaign result is counted as passed. Preserve the specific `body_parser_boundary` final handback/investigation/reproducer hold and the #49 emulator hold. Ordinary reviewed dependency updates are authorized separately and do not clear those held operations or establish live dependency-risk acceptance.

When selecting another revision, independently verify its commit/tree and artifact manifests, refresh both inventories together, and obtain evidence for that revision. Merely editing the expected identity or copying a prior report does not qualify new source. The positive worksheet under [test fixtures](../tests/qualification/fixtures/synthetic-worksheet.json) is synthetic unit-test data and must never be adopted as an operator record.

## Worksheet and instruction trace

Keep actual operator values, logs and receipts outside public Git. Retain every worksheet schema key, using null for unresolved or inapplicable values. Each field required by an operation must be resolved by the responsible operator before that operation can be reported available. For example, the function-build account needs a concrete value for controller installation, while image build and later job operation do not require that field's value. Secret payloads never belong in the worksheet; only numbered version references are accepted.

| Worksheet group | Required decision or observation | Existing instructions |
|---|---|---|
| Source and artifacts | Selected commit/tree and six source bindings; independently verified controller ZIP/receipt hashes and worker source-stage manifest; exact builder digest, base image and resulting image resource/numeric identity | [Source validation](../TEST_SCRIPTS_README.md), [worker source staging](WORKER_IMAGE.md), [image inputs](../docker/README.md) |
| Project and identities | One approved disposable project, region/zone, private subnet/pool and separate build/controller/worker/admin/scheduler identities; immutable subjects and reviewed effective IAM | [Deployment and operator inputs](../DEPLOYMENT.md), [Terraform inputs](../terraform/README.md) |
| Trusted repository and routing | One numeric private workload repository with trusted writers/workflows; one route label, registered labels and the required subset; one job per disposable VM | [Repository trust and routing](../DEPLOYMENT.md), [job example](../examples/one-job-workflow.yml) |
| Capacity and limits | Capacity one first, then two only with a revision-bound capacity-one trial/cleanup receipt; reviewed job/build counts, duration, build timeout, cost ceiling and currency for each stage | [Case inventory](../tests/qualification-cases.json), [deployment acceptance](../DEPLOYMENT.md) |
| Cleanup and retention | Named cleanup owner/deadline and restricted evidence location; retention owner/days, redaction policy and approved storage; preserve uncertain capacity | [Cleanup semantics](../CLEANUP_SCRIPTS_README.md), [removal](../DEPLOYMENT.md) |
| Runner maintenance | Named rebuild owner; selected release/checksum, built image identity, observed post-start runner version/binary hash and update behavior | [Image maintenance](WORKER_IMAGE.md), [native image contract](../docker/README.md) |

Follow the existing build → Terraform → routing → evidence capture → cleanup instructions after separate authorization; this report provides no second deployment route. The packet starts at capacity one; a capacity-two packet keeps the live job, cancellation/recovery and cleanup operations unavailable until the first trial and cleanup have live evidence. Image build and controller install precede that trial and are not gated on it. Positive time/job/build/cost limits, a cleanup deadline and retention policy are required; a report does not check that a deadline is still in the future or enforce spending. The operator must enforce those bounds and stop the trial when any limit is reached.

The runtime identity worksheet records the distinct controller, provisioner, scheduler and worker service accounts from the existing Terraform contract; `scheduler_service_account` identifies Terraform's cleanup account. Runtime operation reports reject any collision among those roles, a worker identity sharing build authority, or a worker subject sharing administrator/scheduler authority. Administrator and scheduler subjects must also differ. These are worksheet consistency checks; effective-IAM and provider identity evidence remain required.

Immutable subjects and image IDs are decimal JSON strings: `identities.worker_unique_id`, `identities.admin_subject`, `identities.scheduler_subject` and `artifacts.worker_image_numeric_id` use quoted decimal digits, such as `"1001"`. In contrast, `repository.id` is a positive JSON integer, such as `1001`. Preserve these types when completing the worksheet.

Packer permits the exact source image to come from a separately approved source project, such as `projects/debian-cloud/global/images/debian-12-fixed`. The build approval must cover that full selected resource. A moving family or shortened image alias is rejected. The resulting `worker_image_resource` must still be an exact image in the selected target project; accepting a cross-project source does not relax that output restriction.

## Per-flag evidence matrix

The validator extracts these eight flag names from exact `flag(env,'NAME')` calls in the bound readiness adapter and compares that set with its fixed table. It compares the plan's prerequisite and operation tables with the Python contract; it does not prove behavioral equivalence with the adapter's runtime logic. The adapter's SHA-256 binding rejects source drift before the textual flag check; a formatting or behavior change needs a reviewed rebind and fresh source qualification. `worksheet.runtime_flags` contains declared values only; it does not read a live deployment, write environment variables or apply Terraform. All checked-in values remain false. Evidence readiness of a flag and permission to enable it are separate decisions. The [deployment adapter](../cloud-functions/webhook-handler/deployment-runtime.js) and [Terraform mapping](../terraform/main.tf) remain unchanged.

| Flag | Property requiring its own evidence |
|---|---|
| `WEBHOOK_ENABLED` | Private repository/routing authority, compatible dependency disposition, allocation transactions and conservative job/cleanup accounting before demand admission |
| `MANAGEMENT_ENABLED` | Exact audience and distinct administrator/scheduler subjects, effective IAM and fenced durable state |
| `SCHEDULED_ENABLED` | Transaction and actual-job reconciliation/cleanup evidence in addition to authenticated management invocation |
| `JIT_PROVIDER_LIFETIME_QUALIFIED` | Actual upstream JIT expiry, installed API behavior and booted image evidence; broker release deadline supplies no upstream lifetime |
| `APPROVED_QUIESCENCE` | Reviewed actor/cgroup boundary and effective authority; local reports are not remote process attestation |
| `DISPATCH_ENABLED` | Durable dispatch and both drain/stop transport properties; worker control also requires quiescence and both worker qualification flags |
| `WORKER_DRAIN_QUALIFIED` | Allocation/incarnation-bound drain and quiescence observations; an acknowledgement is not job completion |
| `WORKER_STOP_QUALIFIED` | Allocation/incarnation-bound stop observations; exit/acceptance is not exact VM or runner absence |

There is no enable-all step. The validator evaluates the required flags and prerequisite union for each named operation, plus the corresponding worksheet fields and cases. Image-build preparation does not borrow unrelated transaction qualification; the ordinary job and cancellation/cleanup reports remain unavailable while their required #48/#49 evidence is held.

## Evidence that must remain distinct

- Record broker `releaseBeforeMs` separately from upstream `providerExpiresAtMs`; a missing upstream value stays unknown.
- Record worker acknowledgement/exit separately from signed actual-job completion and its repository/run/job/attempt/runner correlation.
- Record provider request acceptance separately from authoritative readback proving the exact instance incarnation and owned runner are absent. Unknown outcomes remain charged; never delete allocation state to manufacture free capacity.

Every case specifies the expected durable/provider observation, evidence to retain and stop condition. At cancellation, loss of ownership, unavailable identity, unknown JIT lifetime, ambiguous completion or cleanup uncertainty, stop and involve the named cleanup owner. Source mocks, local unit tests and packaging receipts retain their stated scope.

## Runner rebuild and diagnostic retention

On 24 October 2026, the [official runner release metadata](https://github.com/actions/runner/releases/tag/v2.337.0) identified Linux x64 `2.337.0` with SHA-256 `70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613`, matching [the checked-in release](../docker/runner-release.json). This verifies the selected archive identity against public metadata; no archive download, new image or running binary was verified here. Confirm support for the intended repository before each authorized build because releases are progressive.

[GitHub's runner guidance](https://docs.github.com/en/actions/reference/runners/self-hosted-runners) describes automatic software updates by default and the maintenance deadline when automatic updates are disabled. The current worker invokes `run.sh --jitconfig` and does not disable updates. A baked version therefore does not prove the effective version after startup. The rebuild owner must retain source-stage/build/image identities and record the observed post-start version, binary digest and whether an update occurred. Rebuild from reviewed release/checksum inputs when needed; this packet changes neither update behavior nor images.

The bake script already retains runner release, apt snapshot and installed package metadata under `/usr/share/one-job-worker`. The service suppresses stdout/stderr and the VM is disposable. The operator must decide how permitted runner diagnostics and update/version observations will survive cleanup, with approved access, redaction and retention. GitHub recommends preserving ephemeral diagnostics externally; this packet grants no export authority and adds no exporter, logging principal or retention change. Keep tokens, JIT material, keys and private operational identifiers out of public evidence.

## Offline checks and completion

```sh
python3 -B -m unittest discover -s tests/qualification -p 'test_*.py' -v
```

The existing [Python collector](../scripts/test-python.py) discovers this suite. Run the relevant image/worker regressions and source checks in the [test guide](../TEST_SCRIPTS_README.md); do not invoke held emulator or dependency-update work. Completion of this preparation slice means that another operator can trace the worksheet to the existing instructions and see every unresolved prerequisite and its consequence. It is not a successful live trial, acceptance of residual dependency risk, or deployment/release approval.
