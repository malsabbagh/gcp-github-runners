"""Offline supported provisioning embedding and direct OIDC scheduler contract."""
import json, os, pathlib, subprocess, unittest
ROOT=pathlib.Path(__file__).resolve().parents[2]
class EmbeddingTests(unittest.TestCase):
    def test_provisioning_build_contains_exact_tracked_python_and_safe_environment(self):
        command="const t=require('./tests/provisioning/harness.cjs').load();t.request().then(()=>process.stdout.write(JSON.stringify(t.calls.builds[0])));"
        result=subprocess.run(['node','-e',command],cwd=ROOT,capture_output=True,text=True,timeout=30)
        self.assertEqual(result.returncode,0,result.stderr)
        build=json.loads(result.stdout)['build'];step=build['steps'][0]
        script=(ROOT/'cloud-functions/webhook-handler/provision-runner.py').read_text()
        self.assertEqual(step['args'],['-c',"python3 - <<'RUNNER_PROVISIONER'\n"+script+"\nRUNNER_PROVISIONER"])
        self.assertEqual(step['entrypoint'],'bash')
        self.assertIn('WORKER_SERVICE_ACCOUNT=worker@example-project.iam.gserviceaccount.com',step['env'])
        self.assertFalse(any(('PAT'+'=') in row or ('PRIVATE_KEY'+'=') in row for row in step['env']))
        syntax=subprocess.run(['bash','-n'],input=step['args'][1],text=True,capture_output=True,timeout=10)
        self.assertEqual(syntax.returncode,0,syntax.stderr)
    def test_terraform_scheduler_invokes_unified_authenticated_management_without_cleanup_build(self):
        source=(ROOT/'terraform/main.tf').read_text()
        self.assertIn('/management/scheduled',source)
        self.assertIn('oidc_token',source)
        self.assertRegex(source,r'body\s*=\s*base64encode\("\{\}"\)')
        self.assertNotIn('runner-cleanup.sh',source)
        self.assertNotIn('scheduledCleanup',source)
if __name__=='__main__':unittest.main()
