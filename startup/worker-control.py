"""Outbound authenticated mailbox for an already-consumed one-job worker.

Only local quiescence is reported. The broker authenticates Google Compute
identity and rechecks durable ownership/terminal evidence before accepting an
acknowledgement. Neither a signal nor local exit proves job completion/VM stop.
"""
import json
import os
from pathlib import Path
import re
import time
import urllib.parse
import urllib.request

UUID = r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
SHA = r'[a-f0-9]{64}'


def envelope(operation, worker):
    if not isinstance(operation, dict) or set(operation) != {'version', 'dispatchId', 'phase', 'binding', 'evidenceSha256'} or \
            operation['version'] != 1 or operation['phase'] not in ('drain', 'stop') or \
            not isinstance(operation['dispatchId'], str) or not re.fullmatch(UUID, operation['dispatchId']) or \
            not isinstance(operation['evidenceSha256'], str) or not re.fullmatch(SHA, operation['evidenceSha256']):
        raise ValueError('WORKER_CONTROL_REJECTED')
    bound = operation['binding']
    keys = {'key', 'token', 'name', 'zone', 'project', 'instanceId', 'instanceCreationTimestamp',
            'claimId', 'runnerId', 'runnerName', 'labels', 'receiptSha256'}
    if not isinstance(bound, dict) or set(bound) != keys:
        raise ValueError('WORKER_CONTROL_REJECTED')
    identity = {'key': 'allocationKey', 'token': 'reservationToken', 'name': 'runnerName',
                'instanceId': 'instanceId', 'instanceCreationTimestamp': 'incarnation',
                'runnerId': 'runnerId', 'runnerName': 'runnerName'}
    if any(bound[key] != worker[value] for key, value in identity.items()) or \
            not isinstance(bound['claimId'], str) or not re.fullmatch(UUID, bound['claimId']) or \
            not isinstance(bound['receiptSha256'], str) or not re.fullmatch(SHA, bound['receiptSha256']) or \
            not isinstance(bound['labels'], list) or not 2 <= len(bound['labels']) <= 16 or \
            any(not isinstance(v, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', v) for v in bound['labels']) or \
            len(set(bound['labels'])) != len(bound['labels']) or 'self-hosted' not in bound['labels'] or \
            not isinstance(bound['zone'], str) or not re.fullmatch(r'[a-z0-9-]+', bound['zone']) or \
            not isinstance(bound['project'], str) or not re.fullmatch(r'[a-z][a-z0-9-]{4,28}[a-z0-9]', bound['project']):
        raise ValueError('WORKER_CONTROL_REJECTED')
    return operation


def cgroup_quiet(proc=Path('/proc/self/cgroup'), root=Path('/sys/fs/cgroup')):
    """Require unified cgroup v2 and no process except this supervisor.

    Check subgroups recursively: checking only parent cgroup.procs misses job
    descendants. Unknown/unreadable state always refuses an acknowledgement.
    """
    try:
        rows = proc.read_text().splitlines()
        if len(rows) != 1 or not rows[0].startswith('0::/'):
            return False
        relative = rows[0][4:]
        if '..' in Path(relative).parts:
            return False
        directory = root / relative
        if directory.is_symlink() or not directory.is_dir():
            return False
        def walk_error(error):
            raise error
        for current, dirs, _ in os.walk(directory, onerror=walk_error, followlinks=False):
            if any((Path(current) / name).is_symlink() for name in dirs):
                return False
            path = Path(current) / 'cgroup.procs'
            if path.is_symlink():
                return False
            values = path.read_text().split()
            if any(not v.isascii() or not v.isdigit() or int(v) != os.getpid() for v in values):
                return False
        return True
    except (OSError, ValueError):
        return False


def acknowledge(operation, worker, child, quiet=cgroup_quiet):
    operation = envelope(operation, worker)
    # No active-job graceful drain protocol is invented. A completed ephemeral
    # listener cannot pick up another job; live listeners and lingering job
    # processes must finish (or remain charged pending explicit recovery).
    if child.poll() is None or not quiet():
        return None
    return {'worker': worker, 'operation': operation,
            'state': 'drained' if operation['phase'] == 'drain' else 'stopped'}


def supervise(worker, child, broker_url, metadata, bounded, opener, marker,
              clock_sleep=time.sleep, quiet=cgroup_quiet):
    url = urllib.parse.urlsplit(broker_url)
    if url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError('WORKER_CONTROL_REJECTED')
    base = broker_url.rstrip('/') + '/worker-control/'
    def request(operation, body):
        # Refresh assertions per poll; the bootstrap assertion is never cached.
        assertion = metadata('instance/service-accounts/default/identity?audience=' +
            urllib.parse.quote(broker_url, safe='') + '&format=full')
        return json.loads(bounded(opener, urllib.request.Request(base + operation,
            data=json.dumps(body, separators=(',', ':')).encode(), method='POST',
            headers={'Authorization': 'Bearer ' + assertion, 'Content-Type': 'application/json'})))
    seen = {}
    while True:
        try:
            response = request('poll', worker)
            if not isinstance(response, dict) or set(response) != {'ok', 'operation'} or response['ok'] is not True:
                raise ValueError('WORKER_CONTROL_REJECTED')
            operation = response['operation']
            if operation is not None:
                ack = acknowledge(operation, worker, child, quiet)
                if ack:
                    phase = operation['phase']
                    if phase in seen and seen[phase] != operation:
                        raise ValueError('WORKER_CONTROL_REJECTED')
                    if phase == 'stop' and ('drain' not in seen or
                            seen['drain']['binding'] != operation['binding']):
                        raise ValueError('WORKER_CONTROL_REJECTED')
                    if phase not in seen:
                        # Durable local evidence before submission. Lost responses
                        # retry the same operation acknowledgement, never an action.
                        marker('control-' + operation['dispatchId'] + '.json', ack)
                        seen[phase] = operation
                    request('ack', ack)
        except (OSError, ValueError, RuntimeError):
            # Provider/HTTP errors may contain material. No exception text logs.
            pass
        clock_sleep(5)
