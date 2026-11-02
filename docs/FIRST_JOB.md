# First private runner job

Use this sequence to qualify one native Debian 12 Spot worker, execute one small
trusted job, and prove retirement. This is an operator checklist, not a deployment
command or evidence that the cloud setup already exists. Follow
[the qualification packet](QUALIFICATION.md) for the required evidence and
[deployment setup](../DEPLOYMENT.md) for the canonical Terraform installation.

## Configuration to prepare locally

Keep nonsecret deployment settings in ignored `terraform/terraform.tfvars`, based
on [the example](../terraform/terraform.tfvars.example). Terraform validates the
typed inputs and creates the controller's runtime environment. For CI or an
ephemeral workstation, the same Terraform variables can be supplied through
`TF_VAR_<name>`. Terraform's
[input precedence](https://developer.hashicorp.com/terraform/language/values/variables#variable-definition-precedence)
means a tfvars file overrides `TF_VAR_` values; use an explicit final `-var-file`
for a reviewed override. Do not assume environment variables override a tfvars
file. Keep one authoritative configuration per installation.

The controller already consumes environment variables. The exporter
`scripts/sync-terraform-config.sh` writes ignored `.env.terraform` and YAML files
from deployed Terraform outputs; it does not deploy or automatically load them.
There is no automatic `.env`/JSON settings loader in `npm start`. Prefer these
existing paths over a second runtime configuration format that could drift from
Terraform. A configured local controller can contact real providers: use the
mock fixtures and the explicit loopback integration harness for local testing.

Put only numbered Secret Manager version references in configuration. The HMAC
payload and App private key stay outside Git, tfvars, images and archives.
Secret creation/version access and App grants require their own authorization.
Do not paste credentials into PR comments or qualification receipts.

Before a trial, fill the private worksheet with actual values, not the synthetic
example IDs:

| Input | Required choice |
| --- | --- |
| Target | Dedicated approved project, region, zone, subnet and named Firestore database |
| Images | Exact prequalified native worker image resource/numeric identity and immutable provisioner container digest; function-build identity |
| Repository | Trusted private workload repository, numeric repository ID, owner/name/branch, App and installation IDs, verified runner-group ID |
| Routing | Dedicated label such as `gcp-one-job`; required labels must be included in registered labels and match the workflow |
| Identity | Separate controller/provisioner/scheduler/worker identities; worker has no management OAuth scopes; exact approved administrator subject |
| Limits | `max_runner_vms=1`, one job per VM, trial deadline, currency/spend threshold, cleanup owner and evidence retention |

Keep `scheduler_paused=true` and all eight readiness flags false during source
preparation. Qualification changes to those controls are separate reviewed
operations, not consequences of a passing mock or emulator test.

One job per VM is the architecture; one VM total is this trial's selected ceiling.
Terraform accepts integer `max_runner_vms` values from 1 to 9999 for later reviewed
capacity stages. It does not reject every value above one. The controller and
direct provisioner use the configured global Firestore pool ceiling, counting
uncertain reservations as charged; the scheduler has no separate one-job cap.
Keep the trial value at one. See [the variable validation](../terraform/profile-variables.tf),
[controller reservation](../cloud-functions/webhook-handler/provisioning-state.js)
and [direct provisioner](../cloud-functions/webhook-handler/provision-runner.py).
Editing a local tfvars or exported environment file does not change the deployed
controller. Runtime limit/readiness changes require a separately authorized,
reviewed Terraform apply through the canonical deployment route.

## GitHub App and webhook are separate setup

The repository runner adapter authenticates as a GitHub App installation using
the App ID, installation ID and private key. Install the App only on the intended
private workload repository. Its repository **Administration: write** permission
is required by the repository JIT-runner API and matches this adapter's restricted
installation-token request. Metadata read accompanies the installation. The
adapter rechecks the numeric repository ID, name and private status. This path
does not use browser OAuth, a client secret, an OAuth redirect callback or a PAT.
Verify the configured runner group is usable for that repository. See GitHub's
[repository JIT endpoint](https://docs.github.com/en/rest/actions/self-hosted-runners#create-configuration-for-a-just-in-time-runner-for-a-repository).

Use one delivery source for `workflow_job` events. The supplied setup scripts
create a **repository webhook**, independently of the App's runner API identity:

| Webhook setting | Value |
| --- | --- |
| Payload URL | Terraform `webhook_url`: `https://<controller-host>/<controller-base>/webhook` (use the exact output; the base can be empty) |
| Content type / TLS | `application/json`, SSL verification enabled |
| Event | `workflow_job`, covering queued, in_progress and completed actions |
| Secret | The same payload as the numbered webhook Secret Manager version referenced by the controller |
| Validation | HMAC-SHA256 of the exact received bytes through `X-Hub-Signature-256`; preserve the delivery ID/event headers |

GitHub documents [workflow_job availability and actions](https://docs.github.com/en/webhooks/webhook-events-and-payloads#workflow_job).
An App-webhook alternative needs repository Actions read to receive these events;
it is not required when using the supplied repository-webhook path. Do not
configure both paths accidentally and assume their secrets match. The App setup
URL/callback is not the controller's bootstrap endpoint.

After an authorized controller deployment and separate webhook-registration
approval, `scripts/setup-webhook.sh` or `.ps1` reads the actual Terraform URL and
registers the repository webhook. Do not run it merely to inspect configuration.
Local unit/emulator tests require no webhook or public tunnel. Verify a signed
delivery reaches the deployed `/webhook` route before enabling admissions; a
successful ping alone does not prove job admission, JIT or cleanup.

The worker's `/bootstrap` and `/bootstrap/worker-control/{poll,ack}` requests use
Google metadata identity tokens and exact allocation/VM identity checks. The
management `/management/*` routes use approved operator/scheduler identity and
audience checks. Neither route is a GitHub OAuth callback or the webhook URL.

## Qualification order

1. Finish current-head source CI and independent review, then package the exact
   clean source revision. Keep the ZIP receipt and immutable image provenance.
2. Complete the Firestore adapter acceptance separately. The local diagnostic
   currently retains three transactional GET failures in emulator 1.22.0; passing
   test-only batchGet comparisons do not qualify the production Python GET.
   [The contract diagnosis](../tests/integration/CONTRACT.md) gives the bounded
   choices: a verified upstream fix, a reviewed adapter change, or an explicitly
   authorized synthetic remote database test. Do not mark this gate passed.
3. Inspect the saved Terraform plan and effective IAM, private egress, cloud
   quotas, image availability and distinct service identities. Approve only the
   intended installation. Prove the actual worker cannot read secrets, mutate
   allocation state or invoke Compute management APIs.
4. Observe one image boot and JIT registration with exact instance numeric ID,
   incarnation, allocation/reservation, job/run/attempt and runner ID. Establish
   upstream JIT lifetime separately from the broker's release deadline. Qualify
   drain/stop acknowledgement and actor quiescence before enabling those controls.
5. Copy [the smoke workflow](../examples/one-job-workflow.yml) into the approved
   private workload repository and dispatch it once. It requests the dedicated
   labels, runs a native unprivileged Linux/x64 check, uses no checkout action or
   repository token permissions, and has a five-minute job timeout. Do not retry
   automatically after Spot interruption. Confirm the signed actual job
   association rather than assuming the reservation's job necessarily ran.
   This minimal smoke does not test private repository checkout or job-token
   authorization. Qualify those separately before using a real build workflow.
6. Reconcile completion, exact owned runner deregistration and exact VM absence.
   Confirm the auto-delete boot disk is absent before releasing capacity. A job
   exit, runner going offline, elapsed time or Spot interruption alone is not a
   cleanup receipt. Stop admissions and preserve uncertain allocations for the
   designated cleanup owner.

The current first-job proposal is one `e2-standard-2` Spot VM (2 vCPU, 8 GiB),
30 GiB auto-delete pd-balanced disk, private IP, one five-minute smoke job, no
automatic retry and an attended thirty-minute total trial deadline. The job
timeout is not a VM lifetime or billing cap: local worker exit does not delete
the VM. The operator must perform and verify the bounded retirement at the
deadline, including failure paths. Scheduler activation and extended recovery
testing are separate from this first job.

## Cost and stop decision

The November 2, 2026 published Iowa `e2-standard-2` Spot row was USD 0.040212/hour:
15 minutes of worker compute is about USD 0.0101, or USD 0.0201 for thirty minutes.
Recheck [official Spot pricing](https://cloud.google.com/spot-vms/pricing) for the
actual approved region and date. This is compute only. Boot disks, NAT/IP/egress,
Firestore, controller/build execution, logs, image/artifact storage and any new
networking add charges. With already qualified images, the earlier small-trial
illustration was roughly USD 0.07 in short-lived usage; a new twenty-minute
Packer build added roughly USD 0.16 under its stated build assumptions. These
are planning examples, not quotes, free-tier claims or hard spend caps. Packer's
builder VM is on-demand by default even though runners are Spot.

Inventory persistent charges before approval. Deleting the worker does not
remove custom images, registry objects, NAT/router/IP, Firestore contents or the
controller. Terraform's Firestore deletion policy is `ABANDON`, so destroying the
stack does not by itself remove that database. Retain necessary reconciliation
evidence and review separately what can be removed. See official
[build](https://cloud.google.com/build/pricing),
[Firestore](https://cloud.google.com/firestore/pricing) and
[network pricing](https://cloud.google.com/nat/pricing).

No target project/image or live approval is supplied by this guide. A live
request must name those exact resources, principals, allowed API operations,
maximum duration/count, spend threshold/currency and cleanup owner. Keep the
no-cloud-charge boundary until that concrete request is approved. Do the
source/configuration work independently while those decisions are pending.
