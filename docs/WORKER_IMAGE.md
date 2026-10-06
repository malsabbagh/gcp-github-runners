# Worker image preparation

The native image supports a trusted one-job Linux x64 workload without Docker/container actions or sudo. The [image source guide](../docker/README.md) describes pinned runner provenance, archive safety and offline qualification limits.

Choose these approved build inputs; none is embedded in the repository:

| Input | Requirement |
|---|---|
| `PROJECT_ID`, `ZONE` | Authorized image-build project and zone |
| `BUILD_SUBNETWORK`, `PRIVATE_POOL` | Private Cloud Build connectivity and approved egress |
| `SOURCE_IMAGE` | Exact Debian 12 `projects/.../global/images/...` resource; no moving family |
| `IMAGE_NAME` | New immutable worker image name |
| `APT_SNAPSHOT` | Fixed authenticated Debian snapshot timestamp (`YYYYMMDDTHHMMSSZ`) |
| `PACKER_BUILDER_IMAGE` | Approved Packer/tooling image pinned to `@sha256` |
| `BUILD_SERVICE_ACCOUNT` | Separate authorized image-build identity with reviewed image/VM permissions |

From the repository root, an operator can export the corresponding `PKR_VAR_project_id`, `PKR_VAR_zone`, `PKR_VAR_subnetwork`, `PKR_VAR_source_image`, `PKR_VAR_image_name` and `PKR_VAR_apt_snapshot` values, then validate:

```sh
packer init cloudbuild/worker.pkr.hcl
packer validate cloudbuild/worker.pkr.hcl
```

`init` fetches the fixed Packer plugin; `validate` checks the build definition and inputs. Neither demonstrates a successful image boot. Preserve plugin/tool versions and the exact source/runner/package input inventory.

The following command creates cloud build resources and an image and must be used only for an independently authorized build:

```sh
gcloud builds submit \
  --config=cloudbuild/cloudbuild-worker-image.yaml \
  --project="$PROJECT_ID" \
  --substitutions=_PACKER_BUILDER_IMAGE="$PACKER_BUILDER_IMAGE",_ZONE="$ZONE",_BUILD_SUBNETWORK="$BUILD_SUBNETWORK",_SOURCE_IMAGE="$SOURCE_IMAGE",_IMAGE_NAME="$IMAGE_NAME",_APT_SNAPSHOT="$APT_SNAPSHOT",_BUILD_SERVICE_ACCOUNT="$BUILD_SERVICE_ACCOUNT",_PRIVATE_POOL="$PRIVATE_POOL" \
  .
```

Alternatively, `packer build cloudbuild/worker.pkr.hcl` performs an authorized direct build. Do not use both as competing deployment routes. The image contains a single unprivileged runner installation and the one-job service/control code; no consumed startup marker, token, JIT material or management credential may be baked in.

After building, supply the exact resulting image resource to Terraform. Qualify boot behavior, guest-agent metadata, private GitHub/broker reachability, checksum/provenance, no second boot/remint/listener, cgroup containment, and shutdown/retirement with a disposable trusted job. Worker-control polling is outbound and allocation/incarnation bound; a child exit or acknowledgement is not proof of signed completion or VM absence. No image build or publication is performed by CI.
