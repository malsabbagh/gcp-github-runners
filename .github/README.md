# Repository automation

Public pull-request validation uses GitHub-hosted Ubuntu runners and read-only repository tokens. Checkout credentials are not persisted. Tests receive no cloud/provider secret or OIDC deployment authority. Root CI runs the Node 24 fixture/Jest/Python suites, the per-production-JavaScript-file 81% coverage gate, syntax checks, archive checks, and Terraform validation/mocked tests. Python qualification requires PowerShell and treats skipped suites as failures.

Source-compatible CI materializes an isolated offline qualification tree with synthetic inputs. Its tests retain the separate checked-in dependency locks. A separate `publish-coverage` job receives `contents: write` only after successful validation on a push to `main`. It downloads coverage from that same run and publishes it to the coverage branch without executing the report contents. PR runs cannot invoke this publisher or provide its input artifact. Coverage publication does not enable a Pages site by itself.

`terraform init -backend=false` installs pinned providers without accessing backend state; validation and mocked tests do not deploy. A green test result does not qualify live IAM, images, networking, JIT lifetime or hostile-workload isolation. Repository visibility does not require enabling Actions.
