"""Packaging boundary regressions adapted from historical multi-user shutdown.
These content checks do not qualify retirement/IAM or execute the worker.
Functional controller/provider cases are in cleanup-function/index.test.js.
"""
import pathlib, unittest
ROOT = pathlib.Path(__file__).resolve().parents[2]
class LifecyclePackagingTests(unittest.TestCase):
    def test_one_canonical_reaper_without_competing_cloudbuild_copy(self):
        canonical = ROOT / 'cloud-functions/cleanup-function/runner-cleanup.sh'
        self.assertTrue(canonical.is_file())
        self.assertFalse((ROOT / 'cloudbuild/runner-cleanup.sh').exists())
    def test_helper_has_no_management_secret_or_worker_deregistration(self):
        text = (ROOT / 'cloud-functions/cleanup-function/runner-cleanup.sh').read_text()
        self.assertNotIn('api.github.com', text)
        self.assertNotIn('secrets', text)
        self.assertNotIn('instances\', \'delete', text)
        self.assertIn('print-identity-token', text)
    def test_canonical_controller_owns_capacity_release_and_scheduler_has_no_cloud_build(self):
        controller=(ROOT/'cloud-functions/cleanup-function/retirement-controller.js').read_text()
        adapter=(ROOT/'cloud-functions/cleanup-function/index.js').read_text()
        self.assertIn('runnerAbsent: true, instanceAbsent: true',controller)
        self.assertIn('terminalProof',controller)
        self.assertIn('bootstrapHistory',controller)
        self.assertNotIn('CloudBuildClient',adapter)
        self.assertNotIn("functions.http",adapter)
        self.assertIn('getIdTokenClient',adapter)
if __name__ == '__main__':unittest.main()
