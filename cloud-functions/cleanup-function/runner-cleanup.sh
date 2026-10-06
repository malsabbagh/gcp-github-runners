#!/bin/bash
set -euo pipefail
# Compatibility invocation helper. Canonical controller state owns enumeration,
# incarnation checks and retirement; this identity can only invoke its scheduler.
python3 - <<'PY'
import json, os, subprocess, sys, urllib.parse, urllib.request
def main():
    endpoint = os.environ['CLEANUP_CONTROLLER_URL']
    url = urllib.parse.urlsplit(endpoint)
    audience = os.environ['CONTROLLER_AUDIENCE']
    base = urllib.parse.urlsplit(audience)
    if (url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment
            or base.scheme != 'https' or base.username or base.password or base.query or base.fragment
            or base.netloc != url.netloc or url.path != base.path.rstrip('/') + '/management/scheduled'):
        raise ValueError('invalid_configuration')
    result = subprocess.run(['gcloud', 'auth', 'print-identity-token', '--audiences=' + audience],
                            capture_output=True, text=True, timeout=30)
    token = result.stdout.strip()
    if result.returncode or not token:
        raise ValueError('identity_unavailable')
    request = urllib.request.Request(endpoint, data=b'{}', method='POST',
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            raise ValueError('redirect_denied')
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
        raw = response.read(4097)
        if response.status != 200 or len(raw) > 4096:
            raise ValueError('response_unknown')
        body = json.loads(raw)
        if body.get('ok') is not True or body.get('code') != 'MANAGEMENT_HANDLED' or body.get('status') != 'completed':
            raise ValueError('reconciliation_preserved')
    return 0

try:
    sys.exit(main())
except Exception:
    print('Cleanup preserved resources pending authenticated reconciliation', file=sys.stderr)
    sys.exit(1)
PY
