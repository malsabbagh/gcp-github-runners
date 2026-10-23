# Repository automation

Public pull-request validation uses GitHub-hosted Ubuntu runners and read-only repository tokens. Checkout credentials are not persisted. Tests receive no cloud/provider secret or OIDC deployment authority. Root CI runs the Node 24 fixture/Jest/Python suites, the per-production-JavaScript-file 81% coverage gate, syntax checks, archive checks, and Terraform validation/mocked tests. Python qualification requires PowerShell and treats skipped suites as failures.

Source-compatible CI materializes an isolated offline qualification tree with synthetic inputs. Its tests retain the separate checked-in dependency locks. A separate `publish-coverage` job receives `contents: write` only after successful validation on a push to `main`. It downloads coverage from that same run and publishes it to the coverage branch without executing the report contents. PR runs cannot invoke this publisher or provide its input artifact. Coverage publication does not enable a Pages site by itself.

`terraform init -backend=false` installs pinned providers without accessing backend state; validation and mocked tests do not deploy. A green test result does not qualify live IAM, images, networking, JIT lifetime or hostile-workload isolation. Repository visibility does not require enabling Actions.

## ReviewSensei policy and activation

The checked-in `.reviewsensei.yml` enables automatic reviews, GitHub publication, auto-approval and authorized mentions. It disables provider data egress, learning and review artifacts. It is not a manual-only or advisory-only configuration. The workflow handles eligible PR events, authorized issue/inline mentions, commands, replies and manual dispatch while resolving a frozen PR identity from the trusted default branch.

The caller grants a read-only repository token plus OIDC authority to its external reusable workflow, and explicitly maps provider secret names. Publication depends on the broker/App's independent authorization. Before activating this automation, review and pin the external reusable workflow currently referenced by `@v5`, approve the App/broker/OIDC policy and decide provider egress separately. Do not infer those guarantees from this repository's local resolver tests. No test or source change installs the App, retrieves a provider secret or authorizes egress.

The manual removal workflow creates a cleanup branch, removes setup files, commits, pushes and opens a PR when deliberately invoked. It uses the existing public `malsabbagh` noreply Git identity. Its offline regressions use a temporary Git tree and intercept remote operations.

Enabling repository Actions can activate checked-in automatic workflows. Keep it disabled until these activation requirements and the public-fork policy are reviewed; disabled status is a repository setting, not a permanent code property.
