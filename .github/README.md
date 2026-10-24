# Repository automation

Public pull-request validation uses GitHub-hosted Ubuntu runners and read-only repository tokens. Checkout credentials are not persisted. Tests receive no cloud/provider secret or OIDC deployment authority. Root CI runs the Node 24 fixture/Jest/Python suites, the per-production-JavaScript-file 81% coverage gate, syntax checks, archive checks, and Terraform validation/mocked tests. Python qualification requires PowerShell and treats skipped suites as failures.

Core CI also runs `scripts/qualify-source-profile.py` on Node 24. It materializes a temporary offline qualification tree with synthetic inputs, independently installs the standalone and both reference locks, and runs the reference regression and coverage checks without provider operations. Coverage is generated during checking; no coverage report publisher is configured.

`terraform init -backend=false` installs pinned providers without accessing backend state; validation and mocked tests do not deploy. A green test result does not qualify live IAM, images, networking, JIT lifetime or hostile-workload isolation. Repository visibility does not require enabling Actions.
