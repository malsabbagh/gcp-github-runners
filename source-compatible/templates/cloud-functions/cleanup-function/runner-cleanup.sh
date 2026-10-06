#!/bin/bash
set -euo pipefail
# Safety-first reaper: a running VM is never a cleanup candidate.
# REGION is optional; MAX_AGE_HOURS defaults to 2 (range 0..8760). GitHub PAT is read from Secret
# Manager only for candidates with incarnation-bound successful teardown proof.
python3 - <<'PY'
import datetime, json, os, re, subprocess, sys, urllib.request

def gcloud(*args):
    result = subprocess.run(['gcloud', *args], capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise RuntimeError('gcloud operation failed')
    return result.stdout

def metadata(vm):
    return {i['key']: i.get('value', '') for i in vm.get('metadata', {}).get('items', [])}

def ready(vm):
    info = metadata(vm)
    return (vm.get('status') == 'TERMINATED' and vm.get('labels', {}).get('purpose') == 'github-runner'
            and re.fullmatch(r'[0-9]+', str(vm.get('id', ''))) is not None
            and info.get('runner-cleanup-ready') == str(vm['id'])
            and bool(info.get('repo-owner')) and bool(info.get('repo-name')))

def inventory(owner, repo, token):
    result = []
    total = None
    for page in range(1, 101):
        request = urllib.request.Request(
            f'https://api.github.com/repos/{owner}/{repo}/actions/runners?per_page=100&page={page}',
            headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json'})
        with urllib.request.urlopen(request, timeout=15) as response:
            if response.status != 200:
                raise ValueError('runner API failed')
            body = json.load(response)
        rows, count = body.get('runners'), body.get('total_count')
        if (type(count) is not int or count < 0 or type(rows) is not list
                or any(type(r.get('id')) is not int or r['id'] <= 0
                       or type(r.get('name')) is not str or type(r.get('busy')) is not bool for r in rows)):
            raise ValueError('invalid runner inventory')
        if total is not None and count != total:
            raise ValueError('runner inventory changed while paging')
        total = count
        result += rows
        if len(rows) < 100:
            if len(result) != total or len({r['id'] for r in result}) != total or len({r['name'] for r in result}) != total:
                raise ValueError('incomplete or ambiguous inventory')
            return result
    raise ValueError('runner inventory exceeds safety bound')

def main():
    age = int(os.environ.get('MAX_AGE_HOURS', '2'))
    if not 0 <= age <= 8760:
        raise ValueError('invalid maximum age')
    cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=age)
    vms = json.loads(gcloud('compute', 'instances', 'list', '--filter=labels.purpose=github-runner', '--format=json'))
    token = None
    failures = 0
    for vm in vms:
        name = vm.get('name', '<unknown>')
        try:
            zone = vm['zone'].rsplit('/', 1)[-1]
            region = os.environ.get('REGION', '')
            if region and zone.rsplit('-', 1)[0] != region:
                continue
            created = datetime.datetime.fromisoformat(vm['creationTimestamp'].replace('Z', '+00:00'))
            if created >= cutoff or not ready(vm):
                print(f'Preserving {name}: running, recent, or missing completed-teardown proof')
                continue
            info = metadata(vm)
            # Owner/repository become URL path components, not arbitrary URLs.
            if not re.fullmatch(r'[A-Za-z0-9_.-]+', info['repo-owner']) or not re.fullmatch(r'[A-Za-z0-9_.-]+', info['repo-name']):
                raise ValueError('invalid repository identity')
            if token is None:
                token = gcloud('secrets', 'versions', 'access', 'latest', '--secret=github-runner-token').strip()
                if not token:
                    raise ValueError('missing GitHub token')
            runners = inventory(info['repo-owner'], info['repo-name'], token)
            # Preserve unknown near-prefix registrations as well as recognized names.
            if any(r['name'].startswith(name + '-') for r in runners):
                print(f'Preserving {name}: registrations require reconciliation')
                continue
            current = json.loads(gcloud('compute', 'instances', 'describe', name, '--zone=' + zone, '--format=json'))
            if current.get('id') != vm.get('id') or not ready(current) or metadata(current) != info:
                print(f'Preserving {name}: instance state changed')
                continue
            gcloud('compute', 'instances', 'delete', name, '--zone=' + zone, '--quiet')
            print(f'Deleted completed terminated instance {name}')
        except Exception:
            # Do not emit credential-bearing CLI output or exception payloads.
            print(f'Preserving {name}: cleanup verification failed', file=sys.stderr)
            failures += 1
    return bool(failures)

try:
    sys.exit(main())
except Exception:
    print('Cleanup inventory failed; no further instances will be changed', file=sys.stderr)
    sys.exit(1)
PY
