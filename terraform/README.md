# Configuration interfaces

These files are nondeployable input and output contracts. They contain no
resources, provider blocks, module calls, backend, runtime source, or startup
scripts. Running Terraform would not create infrastructure.

The root declares project, region, zone, and infrastructure labels. Outputs report
supplied inputs. The function and IAM directories are unwired interfaces;
their account references must be supplied by a later reviewed implementation.
No accounts or grants are created here. Controller, provisioner, cleanup, and
worker roles are separate references. The function interface uses controller
and cleanup references only; it does not wire the later roles to runtime code.

The webhook secret input is a numbered version reference. A secret value,
token, private identity, or the latest alias must never be supplied here.

The supported design is a Node webhook, durable Firestore allocations,
controller provisioning, scheduled recovery, one cleanup path, and one job per
private worker VM using Spot capacity. None of that runtime is implemented by
this configuration slice. Direct legacy build provisioning and shared hosts
are excluded.

The historical provider lock and provider declarations are omitted. Terraform
is unavailable in this preparation environment, and no provider install,
init, validation, plan, apply, or runtime test has been performed. Later source
requires separate version, privacy, interface, and IAM qualification.

Native checks use only each variable's own value. They bound syntax, labels,
canonical lowercase account emails, four-role distinctness, and numbered
secret references. They do not prove resource existence, project ownership,
zone-to-region consistency, module alias equality, or runtime authorization.
Repository owner/name are ASCII atoms of at most 100 characters. Branches are
a deliberate single-atom subset of at most 255 characters, with no slash,
whitespace, double dot, or lock suffix. This is not a complete Git ref parser.
Label maps hold one to sixteen metadata entries; keys and nonempty values have
at most 63 lowercase safe characters. They are not runtime routing arrays.
Secret IDs have at most 255 safe characters and version numbers at most 18
digits. Qualification remains pending because Terraform is unavailable.

The historical runner_labels map is infrastructure label and metadata input.
It does not implement GitHub requested or registered runner label lists,
self-hosted eligibility, or job routing. Those runtime contracts are deferred.
