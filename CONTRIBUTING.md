# Contributing

Use the supported one-job Spot architecture and canonical Terraform deployment route. Keep admission repository/label scoped, durable reservations conservative, identity checks incarnation bound and management credentials off workers.

Install with Node 24 and the committed lock; run the complete commands in [TEST_SCRIPTS_README.md](TEST_SCRIPTS_README.md). A skipped Python/PowerShell regression is an incomplete validation result. Add meaningful negative/retry tests when modifying state, authority, provisioning or retirement. Update the [migration ledger](docs/MIGRATION.md), examples and operator configuration whenever a public interface changes.

Examples must contain portable placeholders only. Never commit `.env` files, Terraform state/plans/operator variables, cloud logs, keys, tokens, private operational reports or generated coverage. Secret version references are configuration; the secret values remain in the approved secret channel. Review both the patch and packaged archive before distribution.

Use your verified Git identity for author and committer. Preserve truthful provenance and signer/DCO statements; an attribution change does not create a signature. Submit normal reviewable commits rather than rewriting unrelated published history.

CI and optional ReviewSensei are independent. Deterministic validation must not depend on provider availability, App installation or API-key access. Repository automation and cloud changes require their own explicit operator authorization.
