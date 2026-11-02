#!/usr/bin/env python3
"""Own one disposable, loopback-only emulator; never install tools or use GCP."""
import errno
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
PROJECT = 'demo-gcp-runner-local'
DATABASE = 'runner-local-state'
HOST = '127.0.0.1'
PORT = 18080
WEBSOCKET_PORT = 18081
JAR_SHA256 = '9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c'
FLAGS = ('WEBHOOK_ENABLED', 'MANAGEMENT_ENABLED', 'SCHEDULED_ENABLED',
         'JIT_PROVIDER_LIFETIME_QUALIFIED', 'APPROVED_QUIESCENCE', 'DISPATCH_ENABLED',
         'WORKER_DRAIN_QUALIFIED', 'WORKER_STOP_QUALIFIED')
EVIDENCE_FILES = ('package.json', 'package-lock.json',
    'tests/integration/run-state-integration.py', 'tests/integration/python-process.cjs',
    'tests/integration/python-pool-driver.py', 'tests/integration/state-integration.cjs',
    'tests/local-state-process.test.js', 'tests/qualification/test_local_integration_configuration.py',
    'scripts/check-state-observations.py')


def evidence_path(root, name):
    if not isinstance(name, str) or not name or '\x00' in name:
        raise ValueError('Invalid evidence source path')
    relative = Path(name)
    if relative.is_absolute() or '..' in relative.parts or relative.as_posix() != name:
        raise ValueError('Invalid evidence source path')
    path = root / relative
    if not path.resolve().is_relative_to(root.resolve()) or any(
            item.is_symlink() for item in (path, *path.parents)):
        raise ValueError('Evidence source must remain inside the nonsymlinked checkout')
    return path


def evidence_files(root):
    # Resolve the reviewed production set on invocation, not module import.
    # Its own hash binds that set; inclusion is source identity, not coverage.
    try:
        manifest = evidence_path(root, 'deployment/archive-manifest.json')
        if manifest.stat().st_size > 2 * 1024 * 1024:
            raise ValueError('Oversized archive inventory')
        document = json.loads(manifest.read_text())
        rows = document.get('files') if isinstance(document, dict) else None
        if not isinstance(rows, list) or not 1 <= len(rows) <= 256:
            raise ValueError('Invalid archive inventory files')
        names = [row.get('path') if isinstance(row, dict) else None for row in rows]
        for name in names:
            evidence_path(root, name)
        if len(set(names)) != len(names):
            raise ValueError('Duplicate archive inventory path')
    except (OSError, ValueError, TypeError, RecursionError) as error:
        raise ValueError('Reviewed controller archive evidence inventory is missing or invalid; use a complete checkout') from error
    return tuple(sorted(set(EVIDENCE_FILES) | {'deployment/archive-manifest.json'} | set(names)))


def configuration(environment):
    for key in ('GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CREDENTIALS',
                'CLOUDSDK_AUTH_ACCESS_TOKEN', 'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE'):
        if environment.get(key):
            raise ValueError('Ambient cloud credentials are not allowed')
    for key, value in {'FIRESTORE_EMULATOR_HOST': f'{HOST}:{PORT}',
                       'GOOGLE_CLOUD_PROJECT': PROJECT, 'FIRESTORE_DATABASE_ID': DATABASE}.items():
        if environment.get(key, value) != value:
            raise ValueError('Only the fixed synthetic loopback target is allowed')
    if any(environment.get(flag, 'false') != 'false' for flag in FLAGS):
        raise ValueError('Deployment readiness must remain disabled')
    if environment.get('SCHEDULER_PAUSED', 'true') != 'true':
        raise ValueError('Recovery scheduler must remain paused')
    return {key: value for key, value in environment.items()
            if key in ('PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL')}


def verify_released_ports():
    # A closed TCP connection can remain in TIME_WAIT and reject bind even
    # though the owned server is gone. Require explicit connection refusal;
    # timeout/permission failures are not evidence of successful cleanup.
    for port in (PORT, WEBSOCKET_PORT):
        with socket.socket() as probe:
            probe.settimeout(1)
            if probe.connect_ex((HOST, port)) != errno.ECONNREFUSED:
                raise RuntimeError('Local emulator listener absence not established')


def stop_owned_group(process):
    if process is None:
        return []
    errors = []
    signal_denied = False
    # The Node driver and Java server each own a new process group. Killing
    # only Node on its outer deadline would leave a Python descendant running.
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    except OSError as error:
        errors.append('TERM:' + type(error).__name__)
        signal_denied = True
    try:
        process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        pass
    except OSError as error:
        errors.append('wait-TERM:' + type(error).__name__)
    if not signal_denied:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except OSError as error:
            errors.append('KILL:' + type(error).__name__)
    try:
        process.wait(timeout=5)
    except (OSError, subprocess.TimeoutExpired) as error:
        errors.append('wait-KILL:' + type(error).__name__)
    return errors


def cleanup_owned_processes(node, emulator):
    errors = []
    for label, process in [('node', node), ('emulator', emulator)]:
        try:
            errors.extend(label + ':' + error for error in stop_owned_group(process))
        except Exception as error:
            errors.append(label + ':' + type(error).__name__)
    ports_released = False
    try:
        verify_released_ports()
        ports_released = True
    except Exception as error:
        errors.append('ports:' + type(error).__name__)
    reaped = all(process is None or process.poll() is not None for process in (node, emulator))
    return {'owned_processes_reaped': reaped, 'both_ports_connection_refused': ports_released,
            'database_exported': False, 'errors': errors}


def tap_results(output, returncode):
    totals = {}
    for key in ('tests', 'pass', 'fail', 'skipped', 'cancelled'):
        match = re.search(r'^# ' + key + r' (\d+)$', output, re.MULTILINE)
        totals[key] = int(match[1]) if match else None
    cases = [{'case': match[3], 'status': 'passed' if match[1] == 'ok' else 'failed'}
             for match in re.finditer(r'^(ok|not ok) (\d+) - (.+)$', output, re.MULTILINE)]
    complete = (all(value is not None for value in totals.values()) and
                totals['tests'] == len(cases) and totals['skipped'] == 0 and
                totals['cancelled'] == 0 and totals['tests'] == totals['pass'] + totals['fail'] and
                sum(case['status'] == 'passed' for case in cases) == totals['pass'] and
                sum(case['status'] == 'failed' for case in cases) == totals['fail'])
    return {'total': totals['tests'], 'passed': totals['pass'], 'failed': totals['fail'],
            'skipped': totals['skipped'], 'cancelled': totals['cancelled'],
            'exit_code': returncode, 'complete': complete}, cases


def evidence_hashes(root):
    return {name: hashlib.sha256(evidence_path(root, name).read_bytes()).hexdigest()
            for name in evidence_files(root)}


def verify_observation(root, observation, expected_files=None):
    if expected_files is None:
        expected_files = evidence_files(root)
    hashes = observation.get('tested_files_sha256')
    if not isinstance(hashes, dict) or not hashes:
        raise ValueError('Observation has no source hashes')
    mismatches = ['missing:' + name for name in sorted(set(expected_files) - set(hashes))]
    mismatches.extend('unexpected:' + name for name in sorted(set(hashes) - set(expected_files)))
    for name, expected in hashes.items():
        relative = Path(name)
        if relative.is_absolute() or '..' in relative.parts or not isinstance(expected, str) or not re.fullmatch(r'[a-f0-9]{64}', expected):
            raise ValueError('Invalid observation source binding')
        path = root / relative
        if not path.resolve().is_relative_to(root.resolve()):
            raise ValueError('Observation source escapes repository')
        if name not in expected_files:
            continue
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            mismatches.append(name)
    return mismatches


def require_success(primary_error, result, results, cleanup):
    if primary_error is not None:
        raise RuntimeError('Local integration operation failed; TAP and cleanup evidence retained') from primary_error
    if result or not results['complete'] or results['failed'] or cleanup['errors'] or not cleanup['owned_processes_reaped'] or not cleanup['both_ports_connection_refused']:
        raise RuntimeError('Local integration or cleanup failed; retain the observed results')


def main():
    child_env = configuration(os.environ)
    java = Path(os.environ.get('LOCAL_FIRESTORE_JAVA', '')).resolve()
    jar = Path(os.environ.get('LOCAL_FIRESTORE_JAR', '')).resolve()
    if not java.is_file() or not os.access(java, os.X_OK) or not jar.is_file():
        raise ValueError('Set LOCAL_FIRESTORE_JAVA and LOCAL_FIRESTORE_JAR to existing tools; no automatic installation')
    if hashlib.sha256(jar.read_bytes()).hexdigest() != JAR_SHA256:
        raise ValueError('Expected official Firestore emulator 1.22.0 SHA-256')
    version = subprocess.run([str(java), '-version'], env=child_env,
                             capture_output=True, text=True, check=True, timeout=10)
    if '21.0.13' not in version.stderr + version.stdout:
        raise ValueError('This qualification pins existing Java 21.0.13')
    # Keep the launcher's interpreter path, including a selected virtualenv.
    python = str(Path(sys.executable).absolute())
    java_sha256 = hashlib.sha256(java.read_bytes()).hexdigest()
    child_env.update(FIRESTORE_EMULATOR_HOST=f'{HOST}:{PORT}', GOOGLE_CLOUD_PROJECT=PROJECT,
                     FIRESTORE_DATABASE_ID=DATABASE, PYTHONDONTWRITEBYTECODE='1',
                     SCHEDULER_PAUSED='true', LOCAL_FIRESTORE_PYTHON=python)
    child_env.update({flag: 'false' for flag in FLAGS})
    # Refuse an occupied endpoint; never clear or attach to another service.
    for port in (PORT, WEBSOCKET_PORT):
        with socket.socket() as probe:
            probe.bind((HOST, port))
    process = None
    node = None
    node_timed_out = False
    primary_error = None
    result = None
    source_hashes = evidence_hashes(ROOT)
    source_commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT,
                                           env=child_env, text=True).strip()
    artifact = ROOT / 'dist/state-integration' / (datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8])
    artifact.mkdir(parents=True)
    with tempfile.TemporaryDirectory(prefix='runner-firestore-local-') as directory:
        log = Path(directory) / 'emulator.log'
        command = [str(java), '-Duser.language=en', '-jar', str(jar), '--host', HOST,
                   '--port', str(PORT), '--websocket_port', str(WEBSOCKET_PORT),
                   '--project_id', PROJECT, '--single_project_mode', 'true']
        print(json.dumps({'phase': 'start', 'argv': command, 'project': PROJECT,
                          'database': DATABASE, 'jar_sha256': JAR_SHA256,
                          'java_realpath': str(java), 'java_sha256': java_sha256,
                          'python_realpath': python}), flush=True)
        try:
            with log.open('w') as output:
                process = subprocess.Popen(command, cwd=directory, env=child_env,
                                           stdout=output, stderr=subprocess.STDOUT,
                                           start_new_session=True)
                print(json.dumps({'phase':'owned-process','pid':process.pid}),flush=True)
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            deadline = time.monotonic() + 40
            while True:
                if process.poll() is not None:
                    raise RuntimeError('Owned emulator exited during startup')
                try:
                    with opener.open(f'http://{HOST}:{PORT}/', timeout=1):
                        break
                except Exception:
                    if time.monotonic() >= deadline:
                        raise RuntimeError('Owned emulator did not become ready')
                    time.sleep(0.1)
            with (artifact / 'node.tap').open('w') as output:
                node = subprocess.Popen(['node', '--test', '--test-concurrency=1', '--test-reporter=tap',
                                'tests/integration/state-integration.cjs'], cwd=ROOT,
                               env=child_env, stdout=output, stderr=subprocess.STDOUT,
                               start_new_session=True)
                try:
                    result = node.wait(timeout=180)
                except subprocess.TimeoutExpired:
                    node_timed_out = True
                    result = None
        except Exception as error:
            primary_error = error
        finally:
            cleanup = cleanup_owned_processes(node, process)
            if process is not None:
                print(json.dumps({'phase': 'cleanup', 'owned_pid': process.pid,
                                  'process_reaped': process.poll() is not None,
                                  'node_process_reaped': node is None or node.poll() is not None,
                                  **cleanup}), flush=True)
            if log.exists():
                print('Owned emulator log:\n' + log.read_text(), flush=True)
            if not cleanup['errors'] and cleanup['owned_processes_reaped']:
                print('Owned process reaped; both loopback ports released; database not exported.',flush=True)
        tap = artifact / 'node.tap'
        output = tap.read_text() if tap.exists() else ''
        print(output, flush=True)
        if node_timed_out and node is not None:
            result = node.returncode
        results, cases = tap_results(output, result)
        effects = [json.loads(match[1]) for match in re.finditer(r'^\s*# (\{.*\})$', output, re.MULTILINE)]
        observation = {'schema_version': 1, 'recorded_date': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'source_commit': source_commit,
            'source_note': 'Generated from this run; exact harness and inventoried production bytes are bound by tested_files_sha256, including uncommitted changes. File inclusion does not imply execution coverage.',
            'tested_files_sha256': source_hashes, 'results': results, 'cases': cases,
            'observed_effect_counts': effects,
            'driver_timed_out': node_timed_out,
            'command': ['npm', 'run', 'test:state-integration'],
            'target': {'host': HOST, 'api_port': PORT, 'websocket_port': WEBSOCKET_PORT,
                       'project': PROJECT, 'database': DATABASE},
            'versions': {'python': sys.version.split()[0], 'node': subprocess.check_output(
                ['node', '--version'], env=child_env, text=True).strip(), 'firestore_emulator': '1.22.0'},
            'tool_identity': {'java_binary_sha256': java_sha256,
                              'java_version': (version.stderr + version.stdout).strip(),
                              'emulator_jar_sha256': JAR_SHA256},
            'log_sha256': hashlib.sha256(output.encode()).hexdigest(),
            'cleanup': cleanup,
            'primary_error': type(primary_error).__name__ if primary_error is not None else None,
            'scope': {'cloud_clients': 'mocked', 'readiness_controls': 'all eight false', 'recovery_scheduler_paused': True},
            'qualification': 'Original GET failures remain failures; no live qualification.'}
        if evidence_hashes(ROOT) != source_hashes:
            raise RuntimeError('Source changed during integration; no revision-bound receipt written') from primary_error
        if hashlib.sha256(java.read_bytes()).hexdigest() != java_sha256:
            raise RuntimeError('Java binary changed during integration; no receipt written') from primary_error
        (artifact / 'observations.json').write_text(json.dumps(observation, indent=2) + '\n')
        print('Generated observations: ' + str(artifact / 'observations.json'), flush=True)
        require_success(primary_error, result, results, cleanup)
        print('Local emulator process/database disposed; no cloud operations.', flush=True)


if __name__ == '__main__':
    main()
