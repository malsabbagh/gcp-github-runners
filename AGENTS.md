# GCP GitHub runners agent guide

Read [contribution guidance](CONTRIBUTING.md), the [test commands](TEST_SCRIPTS_README.md)
and [qualification boundaries](docs/QUALIFICATION.md). Preserve the canonical
Terraform route, one-job Spot architecture and conservative reservation and
identity boundaries.

## Development tools and context

The user chooses whether to use TaskAlong, ReviewSensei or ReleaseMarshal through
current task instructions. They are permitted workflow options, not mandatory
steps. This guidance does not grant execution permission, force a custom approval
rule, bypass tool/platform policy, or waive repository protections.

- **TaskAlong:** use it for development orchestration when selected by the user.
  Keep the configured provider, model, account, default development context and
  approved budgets. Normal task context can include relevant source, diffs,
  tests, task instructions, and the configured development tool catalog, rules
  and context. Do not reopen settled routing choices unless the destination,
  data or risk materially changes.
- **ReviewSensei:** use requested CLI review with the configured provider/model
  and relevant code and test context. Fix genuine findings; use targeted,
  evidence-backed dispositions or overrides for nonissues. Reconcile active runs
  before verifying the current immutable head. A submitted disposition is not an
  accepted disposition; partial execution is not a clean review. Submitting a
  native PR approval as an assistant requires specific action-time confirmation;
  this file grants no blanket approval, merge or protection waiver.
- **Destinations and sensitive data:** resolve the effective destination from
  configuration when required, including provider/endpoint, model and account,
  and distinguish local execution from remote inference. Existing configuration
  is not permission for unknown providers or all personal data. Sensitive
  payloads, new destinations and new grants require applicable confirmation.
  Use credentials only through the tool's approved authentication mechanism;
  never include secret values in task context, repository files or logs. Keep
  private account IDs, personal catalog contents and private receipt paths out
  of public documentation, PRs and other published artifacts.
- **Ownership and budgets:** check existing branches, PRs, workers, CI, reviews
  and release runs before starting work. Use isolated worktrees and one writer
  per scope. Do not duplicate an active writer or external run. Do not retry,
  fall back to another provider/model/account, or expand budgets outside the
  approved scope. Reconcile uncertain external writes before another mutation;
  preserve history, usage accounting, receipts and holds rather than resetting
  them to obtain a successful result.

## Release authority and evidence

Run local implementation tests appropriate to the change. Local release
qualification is **not required**: complete green required remote CI on the exact
immutable candidate is authoritative. Do not add a redundant local full-suite or
release-build prerequisite, and do not substitute local results for a missing or
failed remote gate.

When the user authorizes a release and the repository supports ReleaseMarshal,
follow its canonical runbook: Marshal-controlled version tag, remote validation,
build, publication and installed-consumer verification. Qualify the exact
source/generated candidate required by that runbook and preserve protected
approvals and provenance checks. Report actual run URLs, source/version and gate
status; local preparation is not a running release. A code or documentation PR
request does not imply authority for package uploads, credentials, account setup,
deployment or changes to protections. Those actions need their applicable user
grant; neither green CI nor a clean review grants it.

## Cloud and credential boundaries

Mocked local tests and emulator diagnostics do not provision or qualify real cloud
resources and cannot establish a no-charge promise. Provisioning, live cloud tests,
IAM/security changes and deployments need their own explicit operator scope.
Keep secrets out of files, logs and published evidence; use portable placeholders
and the existing approved secret channel. Preserve failed/incomplete diagnostics
and distinguish source tests, emulator evidence and live qualification.
