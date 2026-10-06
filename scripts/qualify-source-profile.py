"""Qualify source-compatible contracts locally without provider operations.

Installation fetches only registry dependencies from the reviewed locks.
Executable tests use synthetic clients and loopback transports.
"""
import ast
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('source_profile', ROOT / 'scripts/source-profile.py')
PROFILE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROFILE)
CHILD = '''
import sys, unittest
suite=unittest.TestLoader().discover(sys.argv[1], pattern='test_*.py')
result=unittest.TextTestRunner(verbosity=1).run(suite)
sys.exit(0 if result.wasSuccessful() and not result.skipped else 1)
'''


def main():
    node = shutil.which('node')
    major = subprocess.check_output([node, '-p', 'process.versions.node.split(".")[0]'], text=True).strip()
    if major != '24':
        raise RuntimeError('Source qualification requires Node24, as does the existing root suite.')
    powershell = os.environ.get('POWERSHELL_BIN') or shutil.which('pwsh')
    if not powershell:
        raise RuntimeError('PowerShell is required; qualification cannot skip its source contracts.')
    manifest = json.loads((PROFILE.PROFILE / 'manifest.json').read_text())
    environment = dict(os.environ, POWERSHELL_BIN=powershell)
    with tempfile.TemporaryDirectory(prefix='runner-source-offline-') as directory:
        work = Path(directory).resolve() / 'source'
        PROFILE.materialize(manifest['inputs_file_example'], work)
        # These locks have separate dependency closures. Borrowing root node_modules
        # would hide incompatible or uninstalled source/hybrid updates.
        for where in [work, work / 'cloud-functions/hybrid-cleanup-handler']:
            lock = where / 'package-lock.json'
            before = hashlib.sha256(lock.read_bytes()).digest()
            subprocess.run(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund',
                            *(['--workspaces=false'] if where != work else [])],
                           cwd=where, env=environment, check=True)
            if hashlib.sha256(lock.read_bytes()).digest() != before:
                raise RuntimeError('Installation changed a reviewed source lock.')
        subprocess.run([node, '--test', str(ROOT / 'tests/parity/source-dependencies.cjs')],
                       env=dict(environment, SOURCE_PROFILE_DIR=str(work)), check=True)
        inherited = []
        for entry in manifest['files']:
            p = work / entry['path']
            command = None
            if p.suffix in ('.js', '.cjs'):
                command = [node, '--check', str(p)]
            elif p.suffix == '.sh':
                command = ['bash', '-n', str(p)]
            elif p.suffix == '.py':
                ast.parse(p.read_text(), filename=entry['path'])
            if command:
                result = subprocess.run(command, text=True, capture_output=True)
                if result.returncode:
                    if entry['path'] == 'scripts/setup-bloated-backup.sh':
                        inherited.append(entry['path'])
                    else:
                        raise RuntimeError('Unexpected source syntax failure: ' + entry['path'])
        for workspace in ['webhook-handler', 'cleanup-function']:
            subprocess.run(['npm', 'run', 'test:coverage-check', '--workspace=' + workspace,
                            '--', '--runInBand'], cwd=work, env=environment, check=True)
        subprocess.run([node, '--test', str(work / 'tests/provisioning/webhook.cjs')],
                       cwd=work, env=environment, check=True)
        for suite in ['lifecycle', 'provisioning']:
            subprocess.run([sys.executable, '-B', '-c', CHILD, str(work / 'tests' / suite)],
                           cwd=work, env=environment, check=True)
        if inherited:
            print('Inherited upstream syntax defect, unchanged from the source: ' + ', '.join(inherited))
        print('Source coverage gates and unit/HTTP/cleanup, dependency and executable lifecycle/provisioning contracts qualified locally; no skips.')


if __name__ == '__main__':
    main()
