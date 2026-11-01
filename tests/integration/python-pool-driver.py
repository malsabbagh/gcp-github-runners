"""Exercise production Pool transaction/codec methods via test-only HTTP transport."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
HOST = '127.0.0.1:18080'
PROJECT = 'demo-gcp-runner-local'
DATABASE = 'runner-local-state'


def main():
    if (os.environ.get('FIRESTORE_EMULATOR_HOST') != HOST or
            os.environ.get('GOOGLE_CLOUD_PROJECT') != PROJECT or
            os.environ.get('FIRESTORE_DATABASE_ID') != DATABASE):
        raise ValueError('Explicit synthetic loopback target required')
    spec = importlib.util.spec_from_file_location('provisioner',
        ROOT / 'cloud-functions/webhook-handler/provision-runner.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    class LocalPool(module.Pool):
        def request(self, suffix, data=None):
            if not suffix.startswith(('/', ':')) or '://' in suffix or '#' in suffix:
                raise ValueError('Invalid local transaction path')
            url = f'http://{HOST}/v1/projects/{PROJECT}/databases/{DATABASE}/documents' + suffix
            request = urllib.request.Request(url,
                data=None if data is None else json.dumps(data).encode(),
                headers={'Content-Type': 'application/json'})
            # HTTP redirects are not part of the emulator contract.
            class NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self, *args, **kwargs):
                    raise ValueError('Local emulator redirects forbidden')
            transport = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
            with transport.open(request, timeout=30) as response:
                return json.load(response)
    pool = LocalPool(PROJECT, '', DATABASE)
    payload = json.load(sys.stdin)
    if payload['operation'].endswith('-batch'):
        class BatchComparisonPool(LocalPool):
            def get_document(self, suffix, transaction):
                name = self.name.rsplit('/provisioning_pools/global', 1)[0] + suffix
                rows = self.request(':batchGet', {'documents': [name], 'transaction': transaction})
                if not isinstance(rows, list) or len(rows) != 1:
                    raise ValueError('Unexpected batchGet response')
                row = rows[0]
                if row.get('missing') == name and 'found' not in row:
                    return None
                if 'missing' not in row and isinstance(row.get('found'), dict) and row['found'].get('name') == name:
                    return row['found']
                raise ValueError('Unbound batchGet response')
        pool = BatchComparisonPool(PROJECT, '', DATABASE)
        payload['operation'] = payload['operation'].removesuffix('-batch')
    if payload['operation'] == 'roundtrip':
        def update(entries, job):
            if job['done'] is not False or job['note'] != 'مرحبا 🌱':
                raise ValueError('Cross-adapter field drift')
            entries[payload['key']]['pythonObserved'] = True
            job['pythonReceipt'] = json.dumps({'observed': True, 'unicode': job['note']}, ensure_ascii=False)
            return job
        result = pool.mutate(update, payload['key'])
    elif payload['operation'] == 'increment':
        def increment(entries, job):
            job['count'] = str(int(job['count']) + 1)
            entries[payload['key']]['count'] = job['count']
            return job['count']
        result = pool.mutate(increment, payload['key'])
    elif payload['operation'] == 'waiting':
        result = pool.waiting(payload['page_size'])
    else:
        raise ValueError('Unknown fixed integration operation')
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
