"""Pure local launcher refusals; never starts Java, an emulator or a provider."""
import importlib.util
import errno
import hashlib
import json
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
            self.assertEqual(LAUNCHER.verify_observation(root, record, ('fixture.py',)), [])
            (root / 'fixture.py').write_text('changed')
            self.assertEqual(LAUNCHER.verify_observation(root, record, ('fixture.py',)), ['fixture.py'])
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

    def test_observation_rejects_incomplete_and_unexpected_manifest_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'one.py').write_text('one')
            (root / 'two.py').write_text('two')
            record = {'tested_files_sha256': {'one.py': hashlib.sha256(b'one').hexdigest()}}
            self.assertEqual(LAUNCHER.verify_observation(root, record, ('one.py', 'two.py')), ['missing:two.py'])
            record['tested_files_sha256']['two.py'] = hashlib.sha256(b'two').hexdigest()
            record['tested_files_sha256']['other.py'] = 'a' * 64
            self.assertEqual(LAUNCHER.verify_observation(root, record, ('one.py', 'two.py')), ['unexpected:other.py'])

    def test_observation_binds_production_adapters_and_rejects_the_historical_harness_only_manifest(self):
        production = 'cloud-functions/webhook-handler/provision-runner.py'
        coordinator = 'cloud-functions/webhook-handler/provisioning-state.js'
        hashes = LAUNCHER.evidence_hashes(LAUNCHER.ROOT)
        self.assertIn(production, hashes)
        self.assertIn(coordinator, hashes)
        self.assertIn('deployment/archive-manifest.json', hashes)
        record = {'tested_files_sha256': hashes.copy()}
        self.assertEqual(LAUNCHER.verify_observation(LAUNCHER.ROOT, record), [])
        record['tested_files_sha256'][production] = '0' * 64
        self.assertEqual(LAUNCHER.verify_observation(LAUNCHER.ROOT, record), [production])
        del record['tested_files_sha256'][production]
        self.assertEqual(LAUNCHER.verify_observation(LAUNCHER.ROOT, record), ['missing:' + production])

    def test_archive_evidence_inventory_missing_or_malformed_fails_on_invocation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'deployment/archive-manifest.json'
            path.parent.mkdir()
            for value in [None, '{', '[]', '{}', '{"files":[]}', '{"files":[{}]}',
                          '{"files":[{"path":"one.py"},{"path":"one.py"}]}']:
                if value is not None:
                    path.write_text(value)
                with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'complete checkout'):
                    LAUNCHER.evidence_files(root)

    def test_archive_evidence_inventory_cannot_hash_paths_outside_checkout(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'deployment/archive-manifest.json'
            path.parent.mkdir()
            for name in ['../outside', '/outside', 'one/../../outside', 'one//two']:
                path.write_text(json.dumps({'files': [{'path': name}]}))
                with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'complete checkout'):
                    LAUNCHER.evidence_hashes(root)

    def test_cleanup_reports_denials_and_timeout_without_retrying_denied_signal(self):
        process = MagicMock(pid=12345)
        process.wait.side_effect = subprocess.TimeoutExpired('synthetic-node', 5)
        with patch.object(LAUNCHER.os, 'killpg', side_effect=PermissionError) as kill:
            errors = LAUNCHER.stop_owned_group(process)
        self.assertEqual(kill.call_count, 1)
        self.assertEqual(errors, ['TERM:PermissionError', 'wait-KILL:TimeoutExpired'])

    def test_cleanup_attempts_both_groups_and_ports_and_preserves_primary_failure(self):
        node = MagicMock(); emulator = MagicMock()
        with patch.object(LAUNCHER, 'stop_owned_group', side_effect=[OSError, ['wait-KILL:TimeoutExpired']]) as stop, \
                patch.object(LAUNCHER, 'verify_released_ports', side_effect=RuntimeError):
            cleanup = LAUNCHER.cleanup_owned_processes(node, emulator)
        self.assertEqual(stop.call_count, 2)
        self.assertEqual(cleanup['errors'], ['node:OSError', 'emulator:wait-KILL:TimeoutExpired', 'ports:RuntimeError'])
        self.assertFalse(cleanup['both_ports_connection_refused'])
        primary = ValueError('synthetic original failure')
        with self.assertRaises(RuntimeError) as caught:
            LAUNCHER.require_success(primary, 1, {'complete': False, 'failed': None}, cleanup)
        self.assertIs(caught.exception.__cause__, primary)
        with self.assertRaises(RuntimeError):
            LAUNCHER.require_success(None, 0, {'complete': True, 'failed': 0}, cleanup)


if __name__ == '__main__':
    unittest.main()
