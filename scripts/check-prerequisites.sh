#!/usr/bin/env bash
# Local inspection only. No authentication, installation, or cloud calls.
set -euo pipefail
missing=0
for cli in git node npm python3 terraform gcloud gh; do
  if command -v "$cli" >/dev/null; then printf '%s: available\n' "$cli"; else printf '%s: missing\n' "$cli"; missing=1; fi
done
if command -v node >/dev/null && [[ $(node -p 'Number(process.versions.node.split(".")[0])') -lt 24 ]]; then echo 'Node.js 24 or newer is required.'; missing=1; fi
if command -v python3 >/dev/null && ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)'; then echo 'Python 3.10 or newer is required.'; missing=1; fi
exit "$missing"
