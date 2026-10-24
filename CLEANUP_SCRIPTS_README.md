# Cleanup and recovery

`cloud-functions/cleanup-function/runner-cleanup.sh` is the canonical conservative inventory helper. It sends requests to the controller; the controller owns exact runner deregistration and VM retirement. The replacement avoids historical direct-delete, offline-runner, hybrid cleanup and copied shared-host cleanup paths.

An old age, absent heartbeat, worker exit, accepted build, cancellation or missing runner name alone does not prove a VM can be retired or its capacity released. Ambiguous identity/provider responses preserve capacity charges. Busy workers remain retained. Active-job graceful drain is not a qualified feature of this profile.

Use authenticated controller management/scheduled routes configured by Terraform. Supply the exact configured audience and caller identity. Inspect the resulting durable allocation status and cloud absence; an HTTP acceptance response is not retirement evidence. The scheduler uses bounded recovery pages so persistent uncertainty does not permit unlimited provisioning.

For manual operations, use the portable fenced management client. Its default validates an ignored local request without authentication or an API call:

```sh
python3 scripts/management.py recover --request /tmp/request.json
```

Supported operations are `requestDrain`, `prepareStop`, `dispatchDrain`, `dispatchStop`, `retire`, `reconcileOrphan`, `recover` and `scheduled`. The request must contain the complete allocation key, token, name, zone, project, numeric instance ID, creation timestamp and claim ID; `scheduled` instead requires `{}`. Do not guess fences from a runner name.

An authorized operator can add `--execute --controller-url HTTPS_ORIGIN --identity-token-file /tmp/token` using an independently obtained short-lived administrator token for the configured audience. The client rejects redirects, hides tokens and arbitrary response fields, and performs no direct provider deletion.

The client prints the controller-reported status with a fixed explanation. `intent_recorded`, `dispatched` and `acknowledged` leave lifecycle completion pending confirmation; `preserved`, `disabled` and `denied` remain distinct. `completed` refers to the requested controller operation, including a scheduled pass, and does not establish retirement of every allocation. Inspect durable records afterward.

A direct `gcloud delete`, raw GitHub runner deletion or Firestore allocation removal bypasses the controller's consistency guarantees and is not a supported cleanup procedure.

With `--execute`, exit code 0 means the controller handled the request and returned a known outcome, including `preserved` or `denied`; it does not establish lifecycle success. Missing, malformed or unknown outcomes and transport failures return exit code 1 with a generic message. Only the recognized status and fixed explanation are printed; arbitrary response fields, reason strings and credentials are not echoed. Local validation remains the default.

The legacy cleanup function source is retained for regression and canonical script packaging compatibility. It is not a second authoritative deployment route. Terraform deploys the selected controller and authenticated scheduled recovery path.

Run Node retirement/lifecycle fixtures and all `tests/lifecycle` Python regressions before changing cleanup. Tests include partial/ambiguous outcomes and do not qualify real provider permissions or timing. See [deployment acceptance](DEPLOYMENT.md#acceptance-before-enabling-lifecycle-controls) before enabling destructive controls.
