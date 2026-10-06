# Monitoring and recovery signals

Monitor the selected controller, provisioner, scheduler and named Firestore database in the operator environment. Historical private alert configuration is replaced by the portable signal specification below and optional Terraform controller ERROR log metric/alert policy. Monitoring defaults to disabled; set `monitoring_enabled=true` and supply existing `monitoring_notification_channels` only for an authorized installation. The optional metric counts filtered logged errors; it does not export allocation state or prove successful work. See [monitoring/README.md](../monitoring/README.md).

| Signal | Meaning and response |
|---|---|
| Queued demand age/backlog | Verify scheduler invocation and eligible label/repository configuration; inspect bounded recovery outcomes |
| Reserved/uncertain VM capacity | Capacity remains charged; reconcile provider outcomes without deleting allocation records |
| Build rejection or ambiguous submission | Inspect the exact allocation/build association securely; retry only through the idempotent controller |
| Bootstrap identity/JIT rejection | Verify image, instance incarnation, worker identity, audience and App/JIT configuration |
| Scheduler authentication failure | Check configured caller subject/audience and invoker grants |
| Busy/unknown retirement outcome | Preserve the runner and charge; investigate exact-incarnation evidence |
| Managed instances without expected durable ownership | Use authenticated conservative inventory/orphan reconciliation; do not age-delete |
| Cloud spend/Spot interruption | Alert using project budget/compute telemetry and test interruption recovery |

Thresholds depend on authorized job duration, capacity limits, reconciliation interval and accepted provider latency. Choose them during target-environment qualification. Record stable reason/status codes and aggregate counts; do not export webhook bodies, tokens, raw JIT material, App keys or private job metadata to public alerts.

A successful HTTP/build acceptance is not successful provisioning or retirement. Monitor convergence to the durable state and exact cloud absence. Keep evidence until uncertain charges are reconciled, including during uninstall.
