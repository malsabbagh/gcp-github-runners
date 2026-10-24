"""Public CLI and build-source boundary regressions; no cloud operations."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'packaging/worker-image-source.py'
CONTRACT = ROOT / 'packaging/worker-image-source.json'
REQUIRED = {
    'LICENSE', 'NOTICE.md', 'cloudbuild/bake-worker.sh',
    'cloudbuild/cloudbuild-worker-image.yaml', 'cloudbuild/worker.pkr.hcl',
    'docker/install-runner.py', 'docker/runner-release.json',
    'startup/one-job-worker.py', 'startup/one-job-worker.service',
    'startup/shutdown-worker.py', 'startup/worker-control.py',
}


class ImageSourceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name).resolve()
        self.source = self.directory / 'source'
        self.source.mkdir()
        for name in REQUIRED:
            target = self.source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, target)
            target.chmod(0o644)
        self.stage = self.directory / 'output'

    def cli(self, command='stage', success=True, script=SCRIPT, output=None):
        result = subprocess.run([sys.executable, '-B', str(script), command,
                                 '--source-root', str(self.source), '--output', str(output or self.stage)],
                                text=True, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0 if success else 1, result.stdout + result.stderr)
        return result

    def test_exact_transitive_inputs_hashes_modes_and_notices(self):
        self.assertEqual({row['path'] for row in json.loads(CONTRACT.read_text())['files']}, REQUIRED)
        self.cli()
        receipt = json.loads((self.stage / 'worker-image-source-manifest.json').read_text())
        self.assertEqual({row['path'] for row in receipt['files']}, REQUIRED | {'.gcloudignore'})
        for row in receipt['files']:
            file = self.stage / row['path']
            self.assertEqual(hashlib.sha256(file.read_bytes()).hexdigest(), row['sha256'])
            self.assertEqual(file.stat().st_mode & 0o7777, int(row['mode'], 8))
        for name in REQUIRED:
            self.assertEqual((self.stage / name).read_bytes(), (ROOT / name).read_bytes())
        self.cli('verify')

    def test_ambient_credentials_state_and_unrelated_files_never_staged(self):
        canaries = ['.env', '.env.prod', 'key.pem', 'private.key', 'terraform.tfstate',
                    'prod.tfvars', 'coverage/report.json', 'unrelated.txt',
                    'cloudbuild/credentials.json', 'docker/unrelated.py', 'startup/.env']
        for name in canaries:
            file = self.source / name
            file.parent.mkdir(exist_ok=True, parents=True)
            file.write_text('SECRET_CANARY')
        (self.source / 'unrelated-link').symlink_to(self.source / '.env')
        self.cli()
        files = {file.relative_to(self.stage).as_posix() for file in self.stage.rglob('*') if file.is_file()}
        self.assertEqual(files, REQUIRED | {'.gcloudignore', 'worker-image-source-manifest.json'})
        self.assertFalse(any(b'SECRET_CANARY' in file.read_bytes() for file in self.stage.rglob('*') if file.is_file()))

    def test_every_required_input_is_required_before_destination_creation(self):
        for name in sorted(REQUIRED):
            with self.subTest(name=name):
                file = self.source / name
                original = file.read_bytes()
                file.unlink()
                self.cli(success=False)
                self.assertFalse(self.stage.exists())
                file.write_bytes(original)

    def test_symlink_input_and_parent_and_nonregular_input_are_rejected(self):
        file = self.source / 'LICENSE'
        file.unlink()
        file.symlink_to(ROOT / 'LICENSE')
        self.cli(success=False)
        file.unlink()
        os.mkfifo(file)
        self.cli(success=False)
        file.unlink()
        shutil.copyfile(ROOT / 'LICENSE', file)
        shutil.rmtree(self.source / 'startup')
        (self.source / 'startup').symlink_to(ROOT / 'startup', target_is_directory=True)
        self.cli(success=False)
        self.assertFalse(self.stage.exists())

    def test_existing_destination_and_symlink_parent_are_rejected_without_overwrite(self):
        self.stage.mkdir()
        marker = self.stage / 'operator.txt'
        marker.write_text('preserve')
        self.cli(success=False)
        self.assertEqual(marker.read_text(), 'preserve')
        alias = self.directory / 'alias'
        alias.symlink_to(self.stage, target_is_directory=True)
        self.cli(success=False, output=alias / 'new')
        self.cli(success=False, output=alias)
        self.assertFalse((self.stage / 'new').exists())

    def test_contract_traversal_absolute_duplicate_and_unsafe_modes_rejected(self):
        script = self.directory / 'worker-image-source.py'
        shutil.copyfile(SCRIPT, script)
        baseline = json.loads(CONTRACT.read_text())
        for row in [{'path': '../LICENSE', 'mode': '0644'}, {'path': '/LICENSE', 'mode': '0644'},
                    {'path': 'startup/../LICENSE', 'mode': '0644'}, {'path': 'LICENSE', 'mode': '0644'},
                    {'path': 'extra', 'mode': '4755'}, {'path': '.env', 'mode': '0644'}]:
            with self.subTest(row=row):
                script.with_suffix('.json').write_text(json.dumps({**baseline, 'files': baseline['files'] + [row]}))
                self.cli(success=False, script=script)
                self.assertFalse(self.stage.exists())
        self.cli(success=False, output=self.directory / 'output' / '..' / 'escape')

    def test_verification_rejects_content_mode_receipt_extra_and_symlink_changes(self):
        self.cli()
        file = self.stage / 'LICENSE'
        original = file.read_bytes()
        file.write_text('changed')
        self.cli('verify', success=False)
        file.write_bytes(original)
        file.chmod(0o600)
        self.cli('verify', success=False)
        file.chmod(0o644)
        extra = self.stage / 'unexpected'
        extra.mkdir()
        self.cli('verify', success=False)
        extra.rmdir()
        extra.symlink_to(self.source / 'LICENSE')
        self.cli('verify', success=False)
        extra.unlink()
        receipt = self.stage / 'worker-image-source-manifest.json'
        receipt.write_text('{}')
        self.cli('verify', success=False)

    def test_ignore_rules_exclude_late_canaries_but_keep_every_staged_file(self):
        self.cli()
        rules = (self.stage / '.gcloudignore').read_text().splitlines()
        # gcloud's directory re-inclusion admits children unless explicitly excluded again.
        # Preserve the rules verified with the real CLI's local list-files-for-upload command.
        for directory in ('cloudbuild', 'docker', 'startup'):
            self.assertIn('/' + directory + '/*', rules)
            self.assertLess(rules.index('!/' + directory + '/'), rules.index('/' + directory + '/*'))
        # Git and gcloud use the same documented basic ignore/negation syntax.
        shutil.copyfile(self.stage / '.gcloudignore', self.stage / '.gitignore')
        subprocess.run(['git', 'init', '-q', str(self.stage)], check=True, capture_output=True)
        canaries = ['private.key', 'cloudbuild/private.key', 'docker/.env', 'startup/extra.py']
        result = subprocess.run(['git', '-C', str(self.stage), 'check-ignore', '--no-index', '--stdin'],
                                input='\n'.join(sorted(REQUIRED) + canaries) + '\n', text=True, capture_output=True)
        self.assertEqual(set(result.stdout.splitlines()), set(canaries))

    def test_cloud_build_step_resolves_staged_packer_and_bake_inputs_with_shim(self):
        self.cli()
        config = (self.stage / 'cloudbuild/cloudbuild-worker-image.yaml').read_text()
        commands = [line.strip() for line in config.splitlines() if line.strip().startswith('packer ')]
        self.assertEqual(commands, ['packer init cloudbuild/worker.pkr.hcl',
                                    'packer validate cloudbuild/worker.pkr.hcl',
                                    'packer build cloudbuild/worker.pkr.hcl'])
        shim = self.directory / 'bin'
        shim.mkdir()
        executable = shim / 'packer'
        executable.write_text('#!/usr/bin/env python3\n' +
                              'from pathlib import Path\nimport sys, re\n' +
                              'assert Path(sys.argv[2]).is_file()\n' +
                              'text = Path(sys.argv[2]).read_text()\n' +
                              'assert re.search(r\'sources\\s*=\\s*\\["startup", "docker", "cloudbuild"\\]\', text)\n' +
                              'assert Path("cloudbuild/bake-worker.sh").is_file()\n' +
                              'assert Path("docker/install-runner.py").is_file()\n' +
                              'assert Path("docker/runner-release.json").is_file()\n' +
                              'assert len(list(Path("startup").glob("*.py"))) == 3\n' +
                              'assert Path("startup/one-job-worker.service").is_file()\n')
        executable.chmod(0o755)
        result = subprocess.run(['sh', '-ec', '\n'.join(commands)], cwd=self.stage,
                                env={**os.environ, 'PATH': str(shim) + os.pathsep + os.environ['PATH']},
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_documented_submit_targets_stage_config_and_ignore_file_with_shim(self):
        self.cli()
        docs = (ROOT / 'docs/WORKER_IMAGE.md').read_text()
        command = re.search(r'```sh\n(gcloud builds submit .*?)\n```', docs, re.S).group(1)
        shim = self.directory / 'bin'
        shim.mkdir()
        executable = shim / 'gcloud'
        executable.write_text('#!/usr/bin/env python3\nimport sys\nfrom pathlib import Path\n' +
                              'args = sys.argv[1:]\nassert args[:2] == ["builds", "submit"]\n' +
                              'stage = Path(args[-1])\nassert stage.is_dir()\n' +
                              'assert "--config=" + str(stage / "cloudbuild/cloudbuild-worker-image.yaml") in args\n' +
                              'assert "--ignore-file=" + str(stage / ".gcloudignore") in args\n' +
                              'assert (stage / "worker-image-source-manifest.json").is_file()\n')
        executable.chmod(0o755)
        result = subprocess.run(['sh', '-ec', command], cwd=ROOT, capture_output=True, text=True,
                                env={**os.environ, 'PATH': str(shim) + os.pathsep + os.environ['PATH'],
                                     'IMAGE_SOURCE': str(self.stage)})
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
