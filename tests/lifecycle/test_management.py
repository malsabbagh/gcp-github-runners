"""Management CLI presentation uses synthetic HTTP responses; no network or provider calls."""
import contextlib
import io
import json
from pathlib import Path
import re
import runpy
import sys
import tempfile
import types
import unittest
import urllib.error
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'scripts/management.py'
STATUSES = ('preserved', 'intent_recorded', 'retired', 'orphan_reconciled', 'hydrated',
            'released', 'absent', 'dispatched', 'acknowledged', 'completed', 'reconciled', 'disabled', 'denied')
CANARY = 'synthetic-response-detail-must-not-be-printed'


class ManagementOutcomeTests(unittest.TestCase):
    def invoke(self, answer=None, *, error=None, execute=True):
        calls = []
        with tempfile.TemporaryDirectory(prefix='management-output-') as directory:
            request = Path(directory) / 'request.json'
            request.write_text('{}')
            token = Path(directory) / 'token'
            token.write_text('synthetic.header.signature')
            argv = [str(SCRIPT), 'scheduled', '--request', str(request)]
            if execute:
                argv += ['--execute', '--controller-url', 'https://controller.example.invalid/function',
                         '--identity-token-file', str(token)]

            def open_response(request, timeout):
                calls.append(request)
                self.assertEqual(timeout, 30)
                self.assertEqual(request.full_url, 'https://controller.example.invalid/function/management/scheduled')
                self.assertEqual(request.data, b'{}')
                self.assertEqual(request.headers['Authorization'], 'Bearer synthetic.header.signature')
                if error:
                    raise error
                return io.BytesIO(json.dumps(answer).encode())

            stdout, stderr = io.StringIO(), io.StringIO()
            opener = types.SimpleNamespace(open=open_response)
            with patch.object(sys, 'argv', argv), patch('urllib.request.build_opener', return_value=opener), \
                    contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                try:
                    runpy.run_path(str(SCRIPT), run_name='__main__')
                    code = 0
                except SystemExit as result:
                    code = result.code
            return code, stdout.getvalue(), stderr.getvalue(), calls

    def test_each_controller_status_is_reported_without_arbitrary_response_fields(self):
        for status in STATUSES:
            with self.subTest(status=status):
                code, output, error, calls = self.invoke({'ok': True, 'code': 'MANAGEMENT_HANDLED',
                    'status': status, 'reason': CANARY, 'material': CANARY})
                self.assertEqual(code, 0)
                self.assertIn('Controller outcome: ' + status + '.', output)
                self.assertEqual(error, '')
                self.assertEqual(len(calls), 1)
                self.assertNotIn(CANARY, output)
                self.assertNotIn('synthetic.header.signature', output)

    def test_pending_preserved_denied_and_completed_are_distinct(self):
        outputs = {}
        for status in ['intent_recorded', 'dispatched', 'acknowledged', 'preserved', 'denied', 'completed']:
            code, output, _, _ = self.invoke({'ok': True, 'code': 'MANAGEMENT_HANDLED', 'status': status})
            self.assertEqual(code, 0)  # The exit code confirms a handled request, not lifecycle convergence.
            outputs[status] = output
        self.assertEqual(len(set(outputs.values())), len(outputs))
        for status in ['intent_recorded', 'dispatched', 'acknowledged']:
            self.assertIn('pending', outputs[status].lower())
        self.assertIn('preserved', outputs['preserved'])
        self.assertIn('denied', outputs['denied'])
        self.assertIn('operation completed', outputs['completed'])
        self.assertNotIn('retired', outputs['completed'])
        self.assertIn('individual allocations may still need attention', outputs['completed'])

    def test_unusable_response_fails_without_echoing_details(self):
        answers = [None, [], CANARY, True, {}, {'ok': False, 'code': CANARY},
                   {'ok': True, 'code': CANARY, 'status': 'completed'},
                   {'ok': True, 'code': 'MANAGEMENT_HANDLED'}]
        answers += [{'ok': True, 'code': 'MANAGEMENT_HANDLED', 'status': status}
                    for status in [None, [], {}, 1, True, CANARY]]
        for answer in answers:
            with self.subTest(answer=answer):
                code, output, error, _ = self.invoke(answer)
                self.assertEqual(code, 1)
                self.assertEqual(output, '')
                self.assertIn('Management request failed', error)
                self.assertNotIn(CANARY, error)
                self.assertNotIn('Traceback', error)

    def test_transport_failure_is_not_a_completed_operation(self):
        code, output, error, calls = self.invoke(error=urllib.error.URLError(CANARY))
        self.assertEqual(code, 1)
        self.assertEqual(output, '')
        self.assertEqual(len(calls), 1)
        self.assertNotIn(CANARY, error)

    def test_default_stays_local_validation_without_an_http_call(self):
        code, output, error, calls = self.invoke(execute=False)
        self.assertEqual(code, 0)
        self.assertIn('validated locally', output)
        self.assertEqual(error, '')
        self.assertEqual(calls, [])

    def test_cli_status_vocabulary_matches_existing_controller_response_contract(self):
        source = (ROOT / 'cloud-functions/webhook-handler/management-http.js').read_text()
        statuses = re.search(r'const safeStatuses = new Set\(\[(.*?)\]\);', source, re.S)
        self.assertIsNotNone(statuses)
        expected = set(re.findall(r"'([^']+)'", statuses.group(1)))
        namespace = runpy.run_path(str(SCRIPT), run_name='management_contract')
        self.assertEqual(set(namespace['OUTCOME_MESSAGES']), expected)


if __name__ == '__main__':
    unittest.main()
