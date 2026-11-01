"""Pure local launcher refusals; never starts Java, an emulator or a provider."""
import importlib.util
import errno
from pathlib import Path
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


if __name__ == '__main__':
    unittest.main()
