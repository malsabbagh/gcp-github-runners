"""Pure local launcher refusals; never starts Java, an emulator or a provider."""
import importlib.util
import errno
import hashlib
from pathlib import Path
import signal
import subprocess
import tempfile
import unittest
from unittest.mock import MagicMock, patch

PATH = Path(__file__).resolve().parents[1] / 'integration/run-state-integration.py'
SPEC = importlib.util.spec_from_file_location('local_integration', PATH)
LAUNCHER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LAUNCHER)


class LocalConfigurationTests(unittest.TestCase):
    def test_ambient_credentials_are_refused(self):
        for key in ['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CREDENTIALS',
                    'CLOUDSDK_AUTH_ACCESS_TOKEN', 'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE']:
            with self.subTest(key=key), self.assertRaises(ValueError):
                LAUNCHER.configuration({key: 'synthetic-forbidden'})

    def test_live_or_ambiguous_targets_are_refused(self):
        for key, value in [('FIRESTORE_EMULATOR_HOST', 'firestore.googleapis.com:443'),
                           ('FIRESTORE_EMULATOR_HOST', 'localhost:18080'),
                           ('FIRESTORE_EMULATOR_HOST', '127.0.0.1:8080'),
                           ('GOOGLE_CLOUD_PROJECT', 'real-project'),
                           ('FIRESTORE_DATABASE_ID', '(default)')]:
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                LAUNCHER.configuration({key: value})

    def test_each_live_control_and_unpaused_scheduler_are_refused(self):
        for key in LAUNCHER.FLAGS:
            with self.subTest(key=key), self.assertRaises(ValueError):
                LAUNCHER.configuration({key: 'true'})
        with self.assertRaises(ValueError):
            LAUNCHER.configuration({'SCHEDULER_PAUSED': 'false'})

    def test_child_environment_drops_proxy_node_and_provider_configuration(self):
        env = LAUNCHER.configuration({'PATH': '/synthetic/bin', 'HTTPS_PROXY': 'synthetic',
            'NODE_OPTIONS': '--require=synthetic', 'CLOUDSDK_CONFIG': '/synthetic',
            'TF_VAR_project_id': 'synthetic'})
        self.assertEqual(env, {'PATH': '/synthetic/bin'})

    def test_cleanup_requires_connection_refusal_on_both_approved_ports(self):
        probe = MagicMock()
        probe.__enter__.return_value = probe
        probe.connect_ex.return_value = errno.ECONNREFUSED
        with patch.object(LAUNCHER.socket, 'socket', return_value=probe):
            LAUNCHER.verify_released_ports()
        self.assertEqual([call.args[0] for call in probe.connect_ex.call_args_list],
                         [('127.0.0.1', 18080), ('127.0.0.1', 18081)])
        for result in [0, errno.EPERM, errno.ETIMEDOUT]:
            probe.connect_ex.return_value = result
            with self.subTest(result=result), patch.object(LAUNCHER.socket, 'socket', return_value=probe):
                with self.assertRaises(RuntimeError):
                    LAUNCHER.verify_released_ports()

    def test_empty_targets_are_rejected_and_empty_credentials_are_not_forwarded(self):
        for key in ['FIRESTORE_EMULATOR_HOST', 'GOOGLE_CLOUD_PROJECT', 'FIRESTORE_DATABASE_ID']:
            with self.subTest(key=key), self.assertRaises(ValueError):
                LAUNCHER.configuration({key: ''})
        for key in ['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CREDENTIALS',
                    'CLOUDSDK_AUTH_ACCESS_TOKEN', 'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE']:
            self.assertNotIn(key, LAUNCHER.configuration({key: ''}))

    def test_tap_receipt_retains_failed_exit_and_rejects_incomplete_or_skipped_runs(self):
        output = 'ok 1 - positive comparison\nnot ok 2 - original GET\n# tests 2\n# pass 1\n# fail 1\n# skipped 0\n# cancelled 0\n'
        result, cases = LAUNCHER.tap_results(output, 1)
        self.assertEqual(result, dict(total=2, passed=1, failed=1, skipped=0,
                                     cancelled=0, exit_code=1, complete=True))
        self.assertEqual([case['status'] for case in cases], ['passed', 'failed'])
        self.assertFalse(LAUNCHER.tap_results('ok 1 - unfinished\n', -15)[0]['complete'])
        self.assertFalse(LAUNCHER.tap_results(output.replace('# skipped 0', '# skipped 1'), 0)[0]['complete'])

    def test_observation_hashes_detect_source_drift_without_rewriting_history(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'fixture.py').write_text('original')
            record = {'tested_files_sha256': {'fixture.py': hashlib.sha256(b'original').hexdigest()}}
            self.assertEqual(LAUNCHER.verify_observation(root, record), [])
            (root / 'fixture.py').write_text('changed')
            self.assertEqual(LAUNCHER.verify_observation(root, record), ['fixture.py'])
            self.assertEqual(record['tested_files_sha256']['fixture.py'], hashlib.sha256(b'original').hexdigest())
            with self.assertRaises(ValueError):
                LAUNCHER.verify_observation(root, {'tested_files_sha256': {'../outside': 'a' * 64}})

    def test_owned_process_group_cleanup_covers_descendants_after_parent_exit(self):
        process = MagicMock(pid=12345)
        with patch.object(LAUNCHER.os, 'killpg') as kill:
            LAUNCHER.stop_owned_group(process)
        self.assertEqual([call.args for call in kill.call_args_list],
                         [(12345, signal.SIGTERM), (12345, signal.SIGKILL)])
        self.assertEqual([call.kwargs for call in process.wait.call_args_list],
                         [{'timeout': 8}, {'timeout': 5}])
        process.wait.reset_mock()
        process.wait.side_effect = [subprocess.TimeoutExpired('synthetic-node', 8), 0]
        with patch.object(LAUNCHER.os, 'killpg', side_effect=[None, ProcessLookupError]):
            LAUNCHER.stop_owned_group(process)
        self.assertEqual(process.wait.call_count, 2)


if __name__ == '__main__':
    unittest.main()
