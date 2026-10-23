# Validation

Use Node 24 and the checked-in npm lock. Python 3, Bash and PowerShell are required to exercise every regression suite without skips. Terraform 1.9.8 and the checked-in provider lock qualify configuration syntax/resources separately.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
node --test tests/*.test.js
npm run test:all --workspace=webhook-handler -- --runInBand
npm test --workspace=cleanup-function -- --runInBand
npm run test:python
npm run check:archive
terraform -chdir=terraform fmt -check -recursive
terraform -chdir=terraform init -backend=false -input=false -lockfile=readonly
terraform -chdir=terraform validate -no-color
```

`npm test` runs the complete built-in Node suite, full webhook and cleanup Jest suites, and `scripts/test-python.py`, which discovers every Python regression directory and fails if any test is skipped. The [CI workflow](.github/workflows/ci.yml) uses the same complete regression scope. It also checks JavaScript/Python/Bash and PowerShell syntax, uses read-only repository permissions and performs no cloud deployment, Pages publication or provider inference.

The built-in Node suites cover controller composition, durable allocation/recovery, bootstrap identity, actual-job association, invocation authentication, retirement, worker control and archive closure. Workspace Jest suites cover webhook and cleanup source. Python covers embedded provisioner, setup tooling, lifecycle helpers and worker behavior with controlled synthetic clients.

Coverage reports are generated locally and ignored:

```sh
npm run test:coverage
npm run test:coverage-check
```

The root coverage collector combines production JavaScript evidence across the fixture and framework test contexts. `npm run test:coverage-check` enforces at least **81% per production JavaScript file** for lines, branches, functions and statements; it includes unexecuted production files so omissions cannot silently improve the percentage. This implements the historical over-80% JavaScript criterion. The gate is a requirement, not a claim that a particular commit passed it: retain the exact final command/report as evidence and resolve any failing files. Python/shell regressions are exercised by the test runner, but no Python/shell coverage percentage or live deployment coverage is claimed. Narrow workspace coverage commands remain diagnostics; they do not replace the root gate.

Qualification evidence should include the exact commit/tree, tool versions, dependency/provider lock hashes, commands, totals, skips and failures. Keep logs free of secret values and private operational identifiers. Regenerate the path ledger after adding/removing a replacement so it cannot silently claim parity for absent files.

Live acceptance requires separately authorized cloud resources and a disposable trusted-repository job. Green source checks cannot establish effective IAM, image provenance, private networking, SDK service behavior, JIT expiry, lifecycle latency or safe retirement of real workers.

The separate source-compatible workflow uses read-only hosted validation and an isolated offline fixture tree. Only its successful main-push publisher has `contents: write`; PR reports are never promoted. Endpoint tests invoke all four PowerShell scripts through their real parameters with request stubs. Workflow regressions parse job policy and verify hostile PR titles remain shell data. Materialization tests check explicit purpose, notice integrity and non-executable reference output. Seven dependency alerts are deferred; these tests do not assert they are remediated.
