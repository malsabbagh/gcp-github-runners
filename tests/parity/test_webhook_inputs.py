"""Exercise webhook script parameter binding without any network requests."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ['test-webhook-signed.ps1', *['archive/old-tests/test-webhook-' + kind + '.ps1' for kind in ['correct', 'debug', 'exact']]]


class WebhookInputsTests(unittest.TestCase):
    def invoke(self, script, parameters, environment=None, redirect=False):
        runtime = os.environ.get('POWERSHELL_BIN') or shutil.which('pwsh')
        self.assertTrue(runtime, 'PowerShell qualification cannot be skipped.')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            program = root / 'invoke.ps1'
            program.write_text('''$ErrorActionPreference = 'Stop'
function Invoke-RestMethod {
 param($Uri,$Method,$Headers,$Body,$MaximumRedirection,$TimeoutSec,$ContentType)
 @{uri=[string]$Uri;method=$Method;body=$Body;headers=$Headers;redirects=$MaximumRedirection;timeout=$TimeoutSec} | ConvertTo-Json -Depth 8 -Compress | Add-Content $env:CALL_LOG
 if ($env:FIXTURE_REDIRECT -eq 'true') {throw 'redirect to untrusted destination'}
 return @{ok=$true}
}
$parameters = ConvertFrom-Json -AsHashtable $env:FIXTURE_PARAMETERS
& $env:FIXTURE_SCRIPT @parameters
''')
            env = dict(os.environ, CALL_LOG=str(root / 'calls.jsonl'), FIXTURE_PARAMETERS=json.dumps(parameters),
                       FIXTURE_SCRIPT=str(ROOT / 'source-compatible/templates' / script), FIXTURE_REDIRECT=str(redirect).lower())
            env.pop('GCP_RUNNER_WEBHOOK_URL', None)
            env.update(environment or {})
            result = subprocess.run([runtime, '-NoLogo', '-NoProfile', '-File', str(program)], cwd=root,
                                    env=env, text=True, capture_output=True, timeout=20)
            calls = [json.loads(line) for line in (root / 'calls.jsonl').read_text().splitlines()] if (root / 'calls.jsonl').exists() else []
            return result, calls

    def parameters(self, **overrides):
        return dict(RepositoryOwner='example', RepositoryName='fixture', RepositoryId=123456, WebhookSecret='synthetic-test-hmac', **overrides)

    def test_all_scripts_reject_unsafe_destinations_before_request(self):
        for script in SCRIPTS:
            for value in [None, '', 'http://example.invalid', 'https://user:pass@example.invalid',
                          'https://example.invalid/?key=value', 'https://example.invalid/#fragment',
                          'https://169.254.169.254', 'https://localhost', 'https://service.internal',
                          'https://example.invalid:444', 'https://example.invalid/\nother',
                          'https://example.invalid/$(payload)', 'https://example.invalid/`payload',
                          'https://example.invalid\\other']:
                with self.subTest(script=script, value=value):
                    parameters = self.parameters()
                    if value is not None:
                        parameters['WebhookUrl'] = value
                    result, calls = self.invoke(script, parameters)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(calls, [])

    def test_cli_precedence_environment_fallback_and_signed_bytes(self):
        import hashlib
        import hmac
        for script in SCRIPTS:
            for parameters, expected in [(self.parameters(WebhookUrl='https://cli.example.invalid/webhook'), 'https://cli.example.invalid/webhook'),
                                         (self.parameters(), 'https://env.example.invalid/function/webhook')]:
                with self.subTest(script=script, expected=expected):
                    result, calls = self.invoke(script, parameters, {'GCP_RUNNER_WEBHOOK_URL':'https://env.example.invalid/function/webhook'})
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(len(calls), 1)
                    call = calls[0]
                    self.assertEqual(call['uri'], expected)
                    self.assertEqual(call['redirects'], 0)
                    self.assertEqual(call['timeout'], 30)
                    digest = hmac.new(b'synthetic-test-hmac', call['body'].encode(), hashlib.sha256).hexdigest()
                    self.assertEqual(call['headers']['x-hub-signature-256'], 'sha256=' + digest)
                    self.assertNotIn(digest, result.stdout + result.stderr)
                    self.assertNotIn('synthetic-test-hmac', result.stdout + result.stderr)
            result, calls = self.invoke(script, self.parameters(WebhookUrl=''), {'GCP_RUNNER_WEBHOOK_URL':'https://env.example.invalid'})
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(calls, [])

    def test_redirect_failure_is_sanitized_without_another_request(self):
        for script in SCRIPTS:
            result, calls = self.invoke(script, self.parameters(WebhookUrl='https://fixture.example.invalid/webhook'), redirect=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(len(calls), 1)
            self.assertNotIn('untrusted destination', result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
