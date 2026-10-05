"""Historical auto-restart behavior is intentionally outside the one-job profile.
No production monitor is bundled by cleanup. These packaging regressions make
that omission explicit; broker/worker lane owns actual one-job marker tests.
"""
import pathlib, unittest
ROOT = pathlib.Path(__file__).resolve().parents[2]
class OneJobMonitorBoundaryTests(unittest.TestCase):
    def test_cleanup_does_not_bundle_old_restart_monitor(self):
        self.assertFalse((ROOT / 'cloudbuild/runner-startup-multi-user-docker.sh').exists())
        self.assertFalse((ROOT / 'cloudbuild/runner-startup-multi-user.sh').exists())
    def test_cleanup_does_not_stop_active_runner_by_age(self):
        text = (ROOT / 'cloud-functions/cleanup-function/runner-cleanup.sh').read_text()
        self.assertNotIn("'instances', 'stop'", text)
        self.assertIn("vm.get('status') == 'TERMINATED'", text)
if __name__ == '__main__':
    unittest.main()
