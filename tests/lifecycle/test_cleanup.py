"""Future offline qualification of the canonical helper; not run in preparation.
Cloud reads and the managed-identity controller request are intercepted. No
GitHub token, Compute deletion or source management script is executed.
"""
import io, json, pathlib, types, unittest
from unittest.mock import patch
ROOT = pathlib.Path(__file__).resolve().parents[2]
PATH = ROOT / 'cloud-functions/cleanup-function/runner-cleanup.sh'
SOURCE = PATH.read_text().split("python3 - <<'PY'\n", 1)[1].rsplit('\nPY', 1)[0]
DEFINITIONS = SOURCE.rsplit('\ntry:\n    sys.exit(main())', 1)[0]

def vm(**changes):
    item = {'name': 'runner-vm', 'id': '12345', 'status': 'TERMINATED',
            'zone': 'projects/example-project/zones/zone-a', 'creationTimestamp': '2000-01-01T00:00:00Z',
            'labels': {'purpose': 'github-runner'}, 'metadata': {'items': [
                {'key': 'allocation-key', 'value': 'a' * 64},
                {'key': 'reservation-token', 'value': 'allocation-' + 'x' * 20}]}}
    item.update(changes)
    return item

class CleanupTests(unittest.TestCase):
    def execute(self, machines, controller_status='retired', controller_error=False):
        calls = []
        def run(args, **kwargs):
            calls.append(args)
            if args[1:4] == ['compute', 'instances', 'list']:
                output = json.dumps(machines)
            elif args[1:3] == ['auth', 'print-identity-token']:
                output = 'synthetic-managed-identity'
            else:
                raise AssertionError('unexpected management command')
            return types.SimpleNamespace(stdout=output, returncode=0)
        def open_request(request, **kwargs):
            calls.append(['controller', request.full_url, json.loads(request.data)])
            if controller_error:
                raise OSError('opaque')
            response = io.BytesIO(json.dumps({'status': controller_status}).encode())
            response.status = 200
            return response
        namespace = {}
        exec(compile(DEFINITIONS, str(PATH), 'exec'), namespace)
        with patch('subprocess.run', run), patch('urllib.request.build_opener', return_value=types.SimpleNamespace(open=open_request)), \
             patch.dict('os.environ', {'PROJECT_ID': 'example-project', 'MAX_AGE_HOURS': '2',
                                      'CLEANUP_CONTROLLER_URL': 'https://controller.example.invalid/retire'}):
            result = namespace['main']()
        return result, calls
    def test_running_starting_and_unknown_never_request_retirement(self):
        for status in ['RUNNING', 'STAGING', 'STOPPING', 'UNKNOWN']:
            code, calls = self.execute([vm(status=status)])
            self.assertFalse(code)
            self.assertEqual(len(calls), 1)
    def test_completed_candidate_requests_controller_but_never_deletes(self):
        code, calls = self.execute([vm()])
        self.assertFalse(code)
        self.assertEqual(len([c for c in calls if c[0] == 'controller']), 1)
        self.assertFalse(any('delete' in c or 'secrets' in c for c in calls))
    def test_unknown_controller_preserves_and_reports_failure(self):
        for status in ['preserved', 'unknown']:
            code, calls = self.execute([vm()], controller_status=status)
            self.assertTrue(code)
            self.assertFalse(any('delete' in c for c in calls))
    def test_transport_failure_does_not_fallback_to_worker_management(self):
        code, calls = self.execute([vm()], controller_error=True)
        self.assertTrue(code)
        self.assertFalse(any('secrets' in c or 'delete' in c for c in calls))
    def test_missing_and_duplicate_allocation_metadata_preserve(self):
        for rows in [[], [{'key': 'allocation-key', 'value': 'a' * 64}] * 2]:
            code, calls = self.execute([vm(metadata={'items': rows})])
            self.assertFalse(any(c[0] == 'controller' for c in calls))
    def test_age_bounds_rejected_before_any_provider_command(self):
        namespace = {}
        exec(compile(DEFINITIONS, str(PATH), 'exec'), namespace)
        for age in ['-1', '8761', 'not-an-age']:
            with patch.dict('os.environ', {'MAX_AGE_HOURS': age}), patch('subprocess.run') as run:
                with self.assertRaises(ValueError): namespace['main']()
                run.assert_not_called()
if __name__ == '__main__':
    unittest.main()
