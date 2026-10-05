#!/bin/bash
set -euo pipefail
# Canonical cleanup build helper. Its cleanup identity can inspect Compute and
# invoke the controller endpoint; it cannot manage GitHub or retrieve App keys.
python3 - <<'PY'
import datetime, json, os, re, subprocess, sys, urllib.parse, urllib.request

def gcloud(*args):
    result = subprocess.run(['gcloud', *args], capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise RuntimeError('cleanup_cloud_read_failed')
    return result.stdout

def metadata(vm):
    rows = vm.get('metadata', {}).get('items', [])
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise ValueError('cleanup_metadata_unknown')
    names = [row.get('key') for row in rows]
    if len(set(names)) != len(names):
        raise ValueError('cleanup_metadata_ambiguous')
    return {row['key']: row.get('value', '') for row in rows}

def ready(vm):
    info = metadata(vm)
    return (vm.get('status') == 'TERMINATED' and vm.get('labels', {}).get('purpose') == 'github-runner'
            and re.fullmatch(r'[0-9]+', str(vm.get('id', ''))) is not None
            and re.fullmatch(r'[a-f0-9]{64}', info.get('allocation-key', '')) is not None
            and re.fullmatch(r'[A-Za-z0-9_-]{16,128}', info.get('reservation-token', '')) is not None)

def main():
    age = int(os.environ.get('MAX_AGE_HOURS', '2'))
    if not 0 <= age <= 8760:
        raise ValueError('invalid_cleanup_age')
    project = os.environ['PROJECT_ID']
    endpoint = os.environ['CLEANUP_CONTROLLER_URL']
    url = urllib.parse.urlsplit(endpoint)
    if url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError('invalid_cleanup_controller')
    cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=age)
    vms = json.loads(gcloud('compute', 'instances', 'list', '--project=' + project,
                           '--filter=labels.purpose=github-runner', '--format=json'))
    if not isinstance(vms, list):
        raise ValueError('cleanup_inventory_unknown')
    failures = 0
    for vm in vms:
        try:
            created = datetime.datetime.fromisoformat(vm['creationTimestamp'].replace('Z', '+00:00'))
            if created >= cutoff or not ready(vm):
                continue
            zone = vm['zone'].rsplit('/', 1)[-1]
            info = metadata(vm)
            payload = {'key': info['allocation-key'], 'token': info['reservation-token'],
                       'name': vm['name'], 'zone': zone, 'instanceId': str(vm['id']), 'project': project,
                       'instanceCreationTimestamp': vm['creationTimestamp']}
            # Standard managed-identity token only, never a GitHub credential.
            identity = gcloud('auth', 'print-identity-token', '--audiences=' + endpoint).strip()
            if not identity:
                raise ValueError('cleanup_caller_identity_missing')
            request = urllib.request.Request(endpoint, data=json.dumps(payload).encode(), method='POST',
                headers={'Authorization': 'Bearer ' + identity, 'Content-Type': 'application/json'})
            # Reject redirects rather than sending the managed identity elsewhere.
            class NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self, *args, **kwargs):
                    raise ValueError('cleanup_redirect_denied')
            opener = urllib.request.build_opener(NoRedirect())
            with opener.open(request, timeout=30) as response:
                raw = response.read(4097)
                if response.status != 200 or len(raw) > 4096:
                    raise ValueError('cleanup_controller_unknown')
                result = json.loads(raw)
                if result.get('status') not in ('retired', 'preserved'):
                    raise ValueError('cleanup_controller_unknown')
                if result.get('status') != 'retired':
                    failures += 1
        except Exception:
            # No names, identity material, CLI output or exception payloads.
            failures += 1
    if failures:
        print('Cleanup preserved resources pending reconciliation', file=sys.stderr)
    return bool(failures)

try:
    sys.exit(main())
except Exception:
    print('Cleanup inventory failed; no capacity release inferred', file=sys.stderr)
    sys.exit(1)
PY
