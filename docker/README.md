# Native one-job worker image

The supported worker is one unprivileged native runner on one disposable private
Spot VM. Container actions and jobs requiring Docker or sudo are unsupported.
There is no Docker daemon/socket, runner fleet in one VM, or inherited PAT.

`cloudbuild/worker.pkr.hcl` bakes a GCE disk image; the instance template references
that image directly. `cloudbuild/cloudbuild-worker-image.yaml` is an explicit
build definition. It is never invoked by webhook admission. A build needs an
approved digest-pinned Packer builder image, exact Debian 12 source image, fixed
Debian apt snapshot, private Cloud Build pool/subnet with egress, separate build
service account and image-build permissions. Packer plugin version is fixed.
No private project, subnet, service account, registry or credential is embedded.

Runner version, architecture, download URL and SHA-256 are in
`runner-release.json`, checked against the checksum in the
[official release](https://github.com/actions/runner/releases/tag/v2.337.0).
`install-runner.py` rejects checksum mismatches, traversal, links/devices,
privileged modes and preconfigured credentials before extracting. Check the
repository's supported download version before adopting the image because
GitHub uses progressive releases. The worker is JIT/ephemeral; it never reruns or
remints after an ambiguous bootstrap. Do not bake a consumed startup marker.

Fixed inputs make dependencies auditable and repeatable, not a promise of
byte-identical GCE disks. The image stores runner provenance, apt snapshot and
installed package versions. Actual Packer build, runner compatibility, image
boot, guest-agent behavior, effective IAM and live drain/retirement have not
been qualified by the offline tests. Do not enable lifecycle qualification flags
from these source tests alone. The worker and trusted job share the disposable
VM identity; local quiescence reports are not a hardware-backed process
attestation. This profile does not admit untrusted pull-request code. No image
is built or published by CI.
