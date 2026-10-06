"""Offline qualification of source-compatible executable contracts, not provider operations."""
import ast
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
        (work / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
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
        for workspace, tests in [('webhook-handler', ['index.unit.test.js', 'index.http.test.js']),
                                 ('cleanup-function', ['index.test.js', 'index.extended.test.js'])]:
            where = work / 'cloud-functions' / workspace
            subprocess.run([node, str(ROOT / 'node_modules/jest/bin/jest.js'), '--runInBand',
                            '--config', str(where / 'package.json'), '--runTestsByPath',
                            *[str(where / test) for test in tests]], cwd=where, env=environment, check=True)
        for suite in ['lifecycle', 'provisioning']:
            subprocess.run([sys.executable, '-B', '-c', CHILD, str(work / 'tests' / suite)],
                           cwd=work, env=environment, check=True)
        if inherited:
            print('Inherited upstream syntax defect, unchanged from the source: ' + ', '.join(inherited))
        print('Source standard unit/HTTP/cleanup and executable lifecycle/provisioning contracts qualified offline; no skips.')


if __name__ == '__main__':
    main()
