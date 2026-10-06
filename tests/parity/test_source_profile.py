"""Validate executable source-profile materialization without executing its commands."""
import hashlib
import importlib.util
import json
from pathlib import Path
import stat
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('source_profile', ROOT / 'scripts/source-profile.py')
PROFILE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROFILE)


class SourceProfileTests(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads((PROFILE.PROFILE / 'manifest.json').read_text())
        self.configuration = self.manifest['inputs_file_example']
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.out = Path(self.temp.name) / 'materialized'

    def test_all_runtime_operator_variant_and_original_test_files_materialize(self):
        self.assertEqual(PROFILE.materialize(self.configuration, self.out), len(self.manifest['files']))
        for file in self.manifest['files']:
            with self.subTest(path=file['path']):
                template = (PROFILE.PROFILE / 'templates' / file.get('template_path', file['path'])).read_text()
                for key, value in self.configuration.items():
                    template = template.replace(key, value)
                output = self.out / file['path']
                self.assertEqual(output.read_text(), template)
                self.assertNotIn('PARITY_INPUT_', output.read_text())
                self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o700 if file['mode'] == '100755' else 0o600)
        for file in ['cloudbuild/runner-startup-multi-user-docker.sh', 'docker/Dockerfile.rust',
                     'scripts/cleanup-offline-runners.ps1', 'scripts/destroy-resources.sh',
                     'cloud-functions/webhook-handler/cleanup-firestore.js',
                     'cloud-functions/webhook-handler/index.comprehensive.test.js']:
            self.assertTrue((self.out / file).is_file())

    def test_missing_configuration_is_rejected_before_writing(self):
        with self.assertRaises(ValueError):
            PROFILE.materialize({}, self.out)
        self.assertFalse(self.out.exists())

    def test_quote_shell_and_newline_injection_are_rejected(self):
        key = next(iter(self.configuration))
        for value in ['sample";bad', 'sample\nother', '$(bad)', '`bad`']:
            with self.subTest(value=value):
                config = dict(self.configuration, **{key: value})
                with self.assertRaises(ValueError):
                    PROFILE.materialize(config, self.out)
                self.assertFalse(self.out.exists())

    def test_existing_operator_inputs_are_not_overwritten(self):
        self.out.mkdir()
        (self.out / 'existing').write_text('retained')
        with self.assertRaises(ValueError):
            PROFILE.materialize(self.configuration, self.out)
        self.assertEqual((self.out / 'existing').read_text(), 'retained')

    def test_template_integrity_is_bound_to_frozen_source(self):
        for file in self.manifest['files']:
            data = (PROFILE.PROFILE / 'templates' / file.get('template_path', file['path'])).read_bytes()
            self.assertEqual(hashlib.sha256(data).hexdigest(), file['template_sha256'])
            self.assertEqual(file['control_logic_changed'], file['path'] in {'scripts/setup-webhook.sh', 'scripts/setup-webhook.ps1'})

    def test_fresh_git_checkout_preserves_template_hashes_and_materializes(self):
        checkout = Path(self.temp.name) / 'checkout'
        indexed = Path(self.temp.name) / 'indexed'
        indexed.mkdir()
        shutil.copyfile(ROOT / '.gitattributes', indexed / '.gitattributes')
        shutil.copytree(PROFILE.PROFILE, indexed / 'source-compatible')
        for arguments in [['init'], ['add', '.'],
                          ['checkout-index', '--all', '--prefix=' + str(checkout) + '/']]:
            subprocess.run(['git', *arguments], cwd=indexed, check=True, capture_output=True)
        self.assertEqual(PROFILE.materialize(self.configuration, self.out,
                                           profile=checkout / 'source-compatible'), 125)


if __name__ == '__main__':
    unittest.main(verbosity=2)
