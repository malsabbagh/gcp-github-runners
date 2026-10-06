"""Restored optional webhook test PRs must target Git, not ignored private inputs."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

PROFILE = load('profile', ROOT / 'scripts/source-profile.py')
OWNER = load('owner', ROOT / '.github/scripts/remove-review-sensei.py')


class GitContextTests(unittest.TestCase):
    def check(self, powershell=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            real_git = shutil.which('git')
            env = dict(os.environ, GIT_AUTHOR_NAME=OWNER.VERIFIED_NAME,
                       GIT_AUTHOR_EMAIL=OWNER.VERIFIED_EMAIL, GIT_COMMITTER_NAME=OWNER.VERIFIED_NAME,
                       GIT_COMMITTER_EMAIL=OWNER.VERIFIED_EMAIL, REAL_GIT=real_git,
                       CALL_LOG=str(root / 'calls.jsonl'))
            def git(*args):
                return subprocess.run([real_git, *args], cwd=root, env=env,
                                      check=True, text=True, capture_output=True).stdout.strip()
            git('init', '--initial-branch=main')
            git('config', 'user.name', OWNER.VERIFIED_NAME)
            git('config', 'user.email', OWNER.VERIFIED_EMAIL)
            git('config', 'commit.gpgsign', 'false')
            (root / '.gitignore').write_text('.materialized/\ncalls.jsonl\nbin/\n')
            git('add', '.gitignore')
            git('commit', '-m', 'Fixture')
            manifest = json.loads((PROFILE.PROFILE / 'manifest.json').read_text())
            work = root / '.materialized' / 'source'
            PROFILE.materialize(manifest['inputs_file_example'], work)
            bins = root / 'bin'; bins.mkdir()
            for command in ['git', 'gh']:
                shim = bins / command
                shim.write_text('''#!/usr/bin/env python3
import json,os,subprocess,sys
from pathlib import Path
command=Path(sys.argv[0]).name
with open(os.environ['CALL_LOG'],'a') as out:
 out.write(json.dumps({'command':command,'args':sys.argv[1:],'cwd':os.getcwd()})+'\\n')
if command=='gh' or sys.argv[1:2]==['push']:sys.exit(0)
sys.exit(subprocess.run([os.environ['REAL_GIT'],*sys.argv[1:]]).returncode)
''')
                shim.chmod(0o755)
            env['PATH'] = str(bins) + os.pathsep + env['PATH']
            if powershell:
                runtime = os.environ.get('POWERSHELL_BIN') or shutil.which('pwsh')
                self.assertTrue(runtime, 'PowerShell qualification cannot be skipped.')
                text = (work / 'scripts/setup-webhook.ps1').read_text()
                body = text[text.index('function Test-Webhook'):text.index('# Main execution')]
                program = work / 'test-helper.ps1'
                program.write_text(body + '\nTest-Webhook fixture fixture\n')
                command = [runtime, '-NoLogo', '-NoProfile', '-File', str(program)]
            else:
                text = (work / 'scripts/setup-webhook.sh').read_text()
                body = text[text.index('test_webhook()'):text.index('# Main execution')]
                command = ['bash', '-c', 'set -e\n' + body + '\ntest_webhook\n']
            result = subprocess.run(command, cwd=work / 'scripts', env=env,
                                    input='y\n', text=True, capture_output=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            self.assertTrue((root / 'test-webhook.md').is_file())
            self.assertFalse((work / 'scripts/test-webhook.md').exists())
            self.assertEqual(git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'), 'test-webhook.md')
            self.assertEqual(git('show', '-s', '--format=%an <%ae> | %cn <%ce>'),
                             f'{OWNER.VERIFIED_NAME} <{OWNER.VERIFIED_EMAIL}> | {OWNER.VERIFIED_NAME} <{OWNER.VERIFIED_EMAIL}>')
            calls = [json.loads(line) for line in (root / 'calls.jsonl').read_text().splitlines()]
            external = [c for c in calls if c['command']=='gh' or c['args'][:1]==['push']]
            self.assertEqual(len(external), 2)
            self.assertTrue(all(Path(c['cwd']) == root for c in external))

    def test_bash_test_branch_commit_push_pr_target_real_checkout(self):
        self.check()

    def test_powershell_test_branch_commit_push_pr_target_real_checkout(self):
        self.check(powershell=True)


if __name__ == '__main__':
    unittest.main(verbosity=2)
