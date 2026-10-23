# Job routing

Configure the same canonical registered labels, required labels and dedicated routing label in Terraform, the controller and the GitHub job. Repository identity and all required labels are admission conditions before state mutation. Infrastructure `runner_labels` metadata does not substitute for the runtime GitHub label lists.

A trusted private repository can adapt this minimal job:

```yaml
name: Trusted one-job runner example
on:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  verify:
    if: github.event.repository.private == true
    runs-on: [self-hosted, linux, x64, dedicated-spot]
    timeout-minutes: 15
    steps:
      - name: Check workspace
        run: python3 -c 'print("one-job worker reached")'
```

`dedicated-spot` is a placeholder for your configured routing label. The worker image must contain the tools needed by the job. A repository with Actions disabled will not dispatch the job. Do not route a public-fork workflow or a job requiring privileged containers to this profile.

Cleanup is controller owned and follows authenticated completion/incarnation evidence. Do not add a job step carrying a management PAT, App private key, Compute permission or raw runner removal token. `always()` workflow steps are not guaranteed retirement evidence after cancellation or interruption.

For qualification, first use a disposable job with no sensitive repository data. Confirm queued/in-progress/completed webhook observations, exactly one issued runner, no restart/re-registration, and cloud absence before charge release. The example is documentation, not an enabled repository workflow.

Public PR examples use hosted runners. Keep private workload repository writers and workflows trusted; a manual dispatch guard is defense in depth, not hostile-code isolation.
