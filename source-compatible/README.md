# Offline compatibility reference

This directory retains compatibility templates, older handlers, worker variants and operator-tool source for inspection and isolated regression qualification. It is not a deployment package. Use the root [supported deployment](../DEPLOYMENT.md) for trusted private workloads.

Legacy variants contain passwordless sudo, shared-host reuse, Docker socket access, worker-side PAT/Secret Manager access, direct cleanup authority and mutable installers. They are unsuitable for public PRs and hostile workloads. Reference file permissions are not a sandbox: do not run these programs against provider resources.

## Readable reference materialization

The materializer verifies template and notice hashes, substitutes explicit ignored local configuration, and writes a new restrictive-permission directory without executing commands. Supply exactly the manifest's `inputs` using the shape in `inputs_file_example`; sample values are inert examples, not deployment credentials.

```sh
python3 scripts/source-profile.py --purpose reference \
  --configuration .source-profile/reference-inputs.json --output-name reference
```

Every output file is non-executable and the tree includes `REFERENCE.md`, `LICENSE` and `NOTICE.md`. Existing directories are never overwritten. Earlier operator-worktree invocations must migrate to the root deployment route; the CLI has no live legacy deployment mode.

Repository qualification harnesses use the explicit Python API purpose `offline-qualification` with synthetic inputs and command shims. Only this mode preserves executable modes needed by the offline tests. It is not exposed as an operator CLI mode. Tests preserve the separate reviewed dependency closures and record inherited failures without presenting them as working deployments. The behavior matrix records these limits; byte equality does not certify security or provider parity.

## Endpoint diagnostic contract

The four signed PowerShell diagnostic scripts require `-WebhookUrl`, or `GCP_RUNNER_WEBHOOK_URL` when the argument is absent. An explicit blank is invalid. The URL must be absolute HTTPS with a DNS hostname and optional safe path, without credentials, query, fragment or a nondefault port. IP, localhost and internal-host destinations are rejected. Requests have a finite timeout and never follow redirects.

Repository owner, name and numeric ID must be explicit inputs, and the existing HMAC secret remains a private operator input. No endpoint or secret is supplied by this repository. Diagnostics sign the exact synthetic payload bytes and print no signature, secret, destination or full payload. An accepted webhook can create workload demand on an authorized deployment; a response is not proof of a successful runner job. Offline regression tests stub every request.

Public workflow examples use hosted runners. The only supported self-hosted example is a separate manual job for a trusted private workload repository, using the root one-job controller. Maintainer approval, dedicated labels and disposable VMs do not qualify arbitrary hostile jobs.
