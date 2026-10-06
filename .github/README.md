# Repository automation

CI qualifies the portable source with Node 24, `npm run check:archive`, and
`npm run test:coverage-check`: all built-in Node fixtures, both complete workspace
Jest suites, and every available Python regression suite (currently
provisioning, lifecycle and worker). Coverage converts Node/Python subprocess
and Jest VM coverage to source locations before merging, includes unloaded
production files, and enforces 81% lines/branches/functions/statements for each
production JavaScript file. CI also checks Bash/PowerShell syntax and Terraform formatting/provider
validation plus mocked infrastructure/IAM tests. Python qualification requires
PowerShell. CI uses
hosted Ubuntu runners and a read-only repository token; it has no cloud
credentials, deployment step, Pages publishing, or provider inference call.
`terraform init -backend=false` installs the checked-in provider lock without
accessing state; `validate` does not deploy. Installation, fixtures and static
validation do not demonstrate a successful live deployment.

## ReviewSensei

The source repository's setup-v5 caller and root configuration are restored.
This migration keeps review invocation manual, automatic reviews and mentions
disabled, publication disabled, advisory reviews, and non-loopback provider
egress disabled. The retained cloud Ollama model is
`deepseek-v4.1-flash:cloud`; that backend cannot run with the current egress
policy. These defaults make the migrated files reviewable without activating
the external service. The reusable workflow follows the source's
operator-managed `malsabbagh/review-sensei` `v5` release tag.

Activation requires a separate operator decision:

1. Allow GitHub Actions and the reusable workflow in repository/organization
   policy, including access to its repository if private.
2. Install/authorize the ReviewSensei GitHub App/broker for this repository and
   confirm its OIDC repository authorization. The caller grants read scopes and
   OIDC; broker policy controls publication rather than a write-scoped token.
3. Select the backend/model in `.reviewsensei.yml`. Supported optional product
   overrides are `REVIEWSENSEI_PROVIDER` and `REVIEWSENSEI_MODEL`. For the selected
   cloud provider, provision the appropriate repository secret (`OLLAMA_API_KEY`,
   `OPENROUTER_API_KEY`, or `OPENAI_API_KEY`) through the approved secret channel;
   only names occur in this repository. Cloud backends use `ubuntu-latest`.
   Local Ollama requires a separately authorized runner with labels
   `[self-hosted, linux, x64, ollama]` and a loopback inference service.
4. Explicitly approve provider data egress before enabling it for a cloud backend.
   Separately approve GitHub publication, mention handling or automatic reviews
   before enabling those controls. Automatic reviews/mentions also require
   restoring the corresponding event triggers in the caller.
5. Manually dispatch a review for a selected PR and verify broker/provider
   authorization and the intended advisory/publication policy.

The removal workflow generates a patch with read-only permissions. Inspect and
apply it locally, then commit with your verified identity; it does not generate
bot commits or remove broker authorization, Apps, provider secrets or learnings.
