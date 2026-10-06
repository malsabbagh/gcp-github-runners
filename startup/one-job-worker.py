"""New one-job worker candidate. No PAT/App key, state writes or cloud management.

Runs once as the unprivileged image user. Provider material exists in memory and
the required upstream runner argv only; that argv exposure is a qualification
limit, not a claim of secret erasure. A private disposable VM is the boundary.
"""
import json
import os
from pathlib import Path
import re
import signal
import ssl
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import importlib.util

STATE = Path('/var/lib/ephemeral-runner')
# Image provisioning installs the verified runner into this private writable
# per-VM directory; upstream runner config/diagnostics also need writes here.
RUNNER = STATE / 'runner/run.sh'
METADATA = 'http://169.254.169.254/computeMetadata/v1/'
MAX_RESPONSE = 131072


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError('WORKER_TRANSPORT_REJECTED')


def fail():
    raise RuntimeError('WORKER_BOOTSTRAP_UNAVAILABLE')


def bounded(opener, request, limit=MAX_RESPONSE):
    with opener.open(request, timeout=15) as response:
        raw = response.read(limit + 1)
        if len(raw) > limit:
            fail()
        return raw


def metadata(path):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    request = urllib.request.Request(METADATA + path, headers={'Metadata-Flavor': 'Google'})
    return bounded(opener, request, 16384).decode('utf-8').strip()


def number(value):
    if not value.isascii() or not value.isdigit() or value.startswith('0') or len(value) > 20:
        fail()
    return value


def private_marker(name, value):
    fd = os.open(STATE / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream, sort_keys=True)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    fd = os.open(STATE, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def main():
    os.umask(0o077)
    if os.geteuid() == 0 or len(sys.argv) != 1 or STATE.is_symlink() or RUNNER.is_symlink():
        fail()
    s = STATE.stat()
    if not stat.S_ISDIR(s.st_mode) or s.st_uid != os.getuid() or s.st_mode & 0o077:
        fail()
    if not RUNNER.is_file() or RUNNER.stat().st_uid != os.getuid() or RUNNER.stat().st_mode & 0o022:
        fail()
    if any((RUNNER.parent / name).exists() for name in ('.runner', '.credentials', '.credentials_rsaparams')):
        fail()
    # Before any exchange. Restart, HTTP ambiguity, crash or power loss never
    # automatically starts another registration. Controller recovery owns it.
    private_marker('consumed-startup.json', {'state': 'started', 'at_ms': int(time.time() * 1000)})
    attrs = {key: metadata('instance/attributes/' + key) for key in (
        'allocation-key', 'reservation-token', 'repo-owner', 'repo-name',
        'run-id', 'job-id', 'run-attempt', 'allocation-broker-url', 'bootstrap-expires-at-ms')}
    url = urllib.parse.urlsplit(attrs['allocation-broker-url'])
    if url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment:
        fail()
    deadline = int(number(attrs['bootstrap-expires-at-ms']))
    now_ms = int(time.time() * 1000)
    if not now_ms < deadline <= now_ms + 900000:
        fail()
    body = {
        'allocationKey': attrs['allocation-key'], 'reservationToken': attrs['reservation-token'],
        'repositoryOwner': attrs['repo-owner'], 'repositoryName': attrs['repo-name'],
        'runId': number(attrs['run-id']), 'jobId': number(attrs['job-id']),
        'attempt': number(attrs['run-attempt']), 'instanceId': number(metadata('instance/id'))}
    # Full identity assertions contain Google-managed Compute identity claims.
    # Broker verifies signature/audience and retrieves authoritative incarnation;
    # worker cannot call Compute or supply its own creation timestamp.
    assertion = metadata('instance/service-accounts/default/identity?audience=' +
        urllib.parse.quote(attrs['allocation-broker-url'], safe='') + '&format=full')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
        urllib.request.HTTPSHandler(context=ssl.create_default_context()), NoRedirect())
    def broker_request(operation):
        return urllib.request.Request(attrs['allocation-broker-url'], method='POST',
            data=json.dumps(body, separators=(',', ':')).encode(),
            headers={'Authorization': 'Bearer ' + assertion, 'Content-Type': 'application/json',
                'X-Bootstrap-Operation': operation})
    # VM starts before the provisioner may persist authoritative active identity.
    # Readiness has no mint/state side effect and may be retried within the TTL.
    ready = False
    while int(time.time() * 1000) < deadline:
        try:
            readiness = json.loads(bounded(opener, broker_request('readiness')))
            if readiness == {'ok': True, 'ready': True}:
                ready = True
                break
            fail()
        except urllib.error.HTTPError as error:
            if error.code != 503:
                fail()
        except (urllib.error.URLError, TimeoutError):
            pass
        time.sleep(2)
    if not ready:
        fail()
    request = broker_request('exchange')
    # Exactly one submission, including if response is lost. No blind remint.
    raw = bounded(opener, request)
    result = json.loads(raw)
    if not isinstance(result, dict) or result.get('ok') is not True or \
            result.get('allocationKey') != body['allocationKey'] or \
            result.get('instanceId') != body['instanceId'] or \
            not isinstance(result.get('encodedJitConfig'), str) or \
            not 0 < len(result['encodedJitConfig']) <= 65536 or \
            type(result.get('runnerId')) is not int or result['runnerId'] < 1 or \
            result.get('runnerName') != metadata('instance/name') or \
            not isinstance(result.get('incarnation'), str) or len(result['incarnation']) > 128 or \
            type(result.get('releaseBeforeMs')) is not int or \
            int(time.time() * 1000) >= min(deadline, result['releaseBeforeMs']):
        fail()
    if not re.fullmatch(r'[A-Za-z0-9+/=_-]+', result['encodedJitConfig']):
        fail()
    private_marker('issued-runner.json', {'allocationKey': body['allocationKey'],
        'instanceId': body['instanceId'], 'runnerId': result['runnerId'],
        'runnerName': result['runnerName'], 'incarnation': result['incarnation']})
    material = result.pop('encodedJitConfig')
    assertion = None
    raw = None
    request = None
    # The upstream interface requires argv. Never print argv/material/environment.
    # JIT is one ephemeral runner; shared labels do not prove assigned job identity.
    child = subprocess.Popen([str(RUNNER), '--jitconfig', material], cwd=str(STATE),
        env={'PATH': '/usr/bin:/bin', 'HOME': str(STATE), 'LANG': 'C.UTF-8'},
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True)
    material = None
    def stop(signum, frame):
        try:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
            else:
                raise SystemExit(0)
        except ProcessLookupError:
            pass
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    code = child.wait()
    private_marker('local-exit.json', {'state': 'exited', 'exit_code': code,
        'at_ms': int(time.time() * 1000), 'completion_proof': False})
    # No second run, deregistration, poweroff, capacity change, or retirement claim.
    # Controller must correlate signed actual-job completion with issued runner.
    # Remain supervised for outbound control acknowledgement after the single
    # listener exits. This never starts a replacement listener or remints a JIT.
    module_path = Path(__file__).with_name('worker-control.py')
    spec = importlib.util.spec_from_file_location('worker_control', module_path)
    control = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(control)
    worker = {**body, 'runnerId': result['runnerId'], 'runnerName': result['runnerName'],
        'incarnation': result['incarnation']}
    control.supervise(worker, child, attrs['allocation-broker-url'], metadata, bounded,
        opener, private_marker)
    return 0 if code == 0 else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        print('WORKER_BOOTSTRAP_UNAVAILABLE', file=sys.stderr)
        raise SystemExit(1)
