# Repository automation

CI qualifies the portable source with Node 24, `npm run check:archive`, and
`npm run test:coverage-check`: all built-in Node fixtures, both complete workspace
Jest suites, and every available Python regression suite (currently
provisioning, lifecycle and worker). Coverage converts Node/Python subprocess
and Jest VM coverage to source locations before merging, includes unloaded
production files, and enforces 81% lines/branches/functions/statements for each
production JavaScript file. CI also checks Bash/PowerShell syntax and Terraform formatting/provider
validation plus mocked infrastructure/IAM tests. Python qualification requires
PowerShell. CI uses
hosted Ubuntu runners and a read-only repository token; it has no cloud
credentials, deployment step, Pages publishing, or provider inference call.
`terraform init -backend=false` installs the checked-in provider lock without
accessing state; `validate` does not deploy. Installation, fixtures and static
validation do not demonstrate a successful live deployment.

## ReviewSensei

The setup-v5 caller now restores the source event behavior: eligible PR events,
authorized issue/inline mentions, rescan/command/reply handling and manual
dispatch. The root configuration matches selected source PR #25, including
automatic reviews, publication, auto-approval and mentions. Provider data egress
remains false, as it is in the source. The caller retains trusted default-branch
resolution and a frozen PR identity; it follows the operator-managed v5 tag.

The removal workflow again creates a cleanup branch, removes setup files,
commits, pushes and opens a PR. Both author and committer use the existing
verified `malsabbagh <malsabbagh@users.noreply.github.com>` identity instead of
the source's bot identity. Offline tests use a real temporary Git tree and
intercept all push/GitHub operations. Running the workflow is a separate action;
restoring its code does not dispatch it or change repository settings.

The additional source-compatible executable profile restores source operator
commands and worker variants; see [the profile guide](../source-compatible/README.md).
