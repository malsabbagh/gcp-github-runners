# Security boundaries and reporting

Report a suspected vulnerability privately through the repository owner's authorized private channel or GitHub's private vulnerability reporting facility if enabled. Do not post credentials, exploit payloads containing private operational data or sensitive state in a public issue. No security contact address is invented here.

The supported workload is explicitly eligible trusted private repository jobs. Public-fork and arbitrary hostile jobs, shared-host multi-user isolation and privileged Docker-socket workloads have not been qualified. One disposable VM limits reuse; it does not by itself establish a complete adversarial isolation boundary.

Security-sensitive invariants include HMAC authentication over raw webhook bytes before state mutation; configured repository and label admission; transactional capacity reservations; allocation/incarnation-bound JIT release; worker/controller credential separation; authenticated audience/subject checks; conservative ambiguous-outcome recovery; and exact runner/VM retirement with cloud absence before capacity release.

Private data must not enter committed trees or archives. Keep secrets in external stores, use numbered references, and exclude local Terraform state/variables, `.env` exports, logs, copied reports and historical operational dumps. Review dependency/image provenance and effective IAM in the target environment. A source scan is bounded evidence and does not certify an exhaustive absence of secrets or vulnerabilities.

Do not enable destructive lifecycle, transport, JIT or scheduler qualification controls solely because fixtures pass. A real installation must demonstrate the corresponding identity, provider-lifetime, network, quiescence and retirement properties using the acceptance process in [DEPLOYMENT.md](DEPLOYMENT.md).

Public PR validation must use hosted runners without cloud/provider secrets. The controller verifies configured numeric repository identity and current private status before new demand, Cloud Build submission and JIT release. Signature and labels alone do not establish job trust. Terminal observations retain exact runner/incarnation checks even when new demand is denied. Legacy shared-host, sudo, Docker-socket and worker-PAT variants are offline reference material, not supported deployment.

Seven known dependency alerts remain deferred for follow-up. They have not been dismissed or declared fixed. Source tests do not qualify arbitrary hostile workloads, third-party dependencies, or live IAM/network isolation. Review the actual automation policy before enabling Actions, including ReviewSensei's configured writes/auto-approval and the separate trusted-main coverage publisher.
