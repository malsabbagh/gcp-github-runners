# Runner operational signals

Optional `monitoring_enabled=true` creates a controller ERROR log metric and an
alert policy. Supply existing channel resource names via
`monitoring_notification_channels`; Terraform never creates recipients or sends
messages during local verification. Monitoring is disabled by default.

After an explicitly approved deployment, filter Cloud Logging by
`resource.type="cloud_run_revision"` and the deployed controller service name.
Check HTTP errors, denied identity requests, Cloud Scheduler failures, provisioning
build failures and Cloud NAT errors. Function logs should contain event identities
and bounded status codes, never raw webhook bodies, bearer tokens or secret values.

The metric reports logged errors; it does not export allocation state or prove
successful work. Inspect the selected Firestore database's durable provisioning
pool when capacity is exhausted. Preserve unknown/pending charges until exact
provider absence and allocation ownership have been proved. A filtered VM list,
failed build, elapsed timeout or missing log is not sufficient absence evidence.

Before accepting workload traffic, qualify one queued job, completion, cancellation,
Spot preemption, duplicate deliveries, denied worker management calls, bounded
scheduler recovery and an interrupted insert that may have succeeded. Confirm
that full inventory agrees with the durable reservation count and the configured
VM ceiling. Do not restore the source's time-based legacy reaper.
