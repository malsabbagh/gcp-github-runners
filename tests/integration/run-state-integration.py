#!/usr/bin/env python3
"""Own one disposable, loopback-only emulator; never install tools or use GCP."""
import errno
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

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


def main():
    child_env = configuration(os.environ)
    java = Path(os.environ.get('LOCAL_FIRESTORE_JAVA', ''))
    jar = Path(os.environ.get('LOCAL_FIRESTORE_JAR', ''))
    if not java.is_file() or not os.access(java, os.X_OK) or not jar.is_file():
        raise ValueError('Set LOCAL_FIRESTORE_JAVA and LOCAL_FIRESTORE_JAR to existing tools; no automatic installation')
    if hashlib.sha256(jar.read_bytes()).hexdigest() != JAR_SHA256:
        raise ValueError('Expected official Firestore emulator 1.22.0 SHA-256')
    version = subprocess.run([str(java), '-version'], env=child_env,
                             capture_output=True, text=True, check=True, timeout=10)
    if '21.0.13' not in version.stderr + version.stdout:
        raise ValueError('This qualification pins existing Java 21.0.13')
    child_env.update(FIRESTORE_EMULATOR_HOST=f'{HOST}:{PORT}', GOOGLE_CLOUD_PROJECT=PROJECT,
                     FIRESTORE_DATABASE_ID=DATABASE, PYTHONDONTWRITEBYTECODE='1',
                     SCHEDULER_PAUSED='true')
    child_env.update({flag: 'false' for flag in FLAGS})
    # Refuse an occupied endpoint; never clear or attach to another service.
    for port in (PORT, WEBSOCKET_PORT):
        with socket.socket() as probe:
            probe.bind((HOST, port))
    process = None
    with tempfile.TemporaryDirectory(prefix='runner-firestore-local-') as directory:
        log = Path(directory) / 'emulator.log'
        command = [str(java), '-Duser.language=en', '-jar', str(jar), '--host', HOST,
                   '--port', str(PORT), '--websocket_port', str(WEBSOCKET_PORT),
                   '--project_id', PROJECT, '--single_project_mode', 'true']
        print(json.dumps({'phase': 'start', 'argv': command, 'project': PROJECT,
                          'database': DATABASE, 'jar_sha256': JAR_SHA256}), flush=True)
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
            result = subprocess.run(['node', '--test', '--test-concurrency=1',
                            'tests/integration/state-integration.cjs'], cwd=ROOT,
                           env=child_env, check=False, timeout=180)
        finally:
            if process is not None:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=8)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait(timeout=5)
                print(json.dumps({'phase': 'cleanup', 'owned_pid': process.pid,
                                  'process_reaped': process.poll() is not None,
                                  'database_exported': False}), flush=True)
            if log.exists():
                print('Owned emulator log:\n' + log.read_text(), flush=True)
            verify_released_ports()
            print('Owned process reaped; both loopback ports released; database not exported.',flush=True)
        if result.returncode:
            raise RuntimeError('Local integration tests failed; retain the observed results')
        print('Local emulator process/database disposed; no cloud operations.', flush=True)


if __name__ == '__main__':
    main()
