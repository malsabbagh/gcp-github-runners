"""Canonical cleanup invocation: cloud identity only, no VM/runner mutations."""
import io, json, pathlib, types, unittest
from unittest.mock import patch
ROOT=pathlib.Path(__file__).resolve().parents[2]
PATH=ROOT/'cloud-functions/cleanup-function/runner-cleanup.sh'
SOURCE=PATH.read_text().split("python3 - <<'PY'\n",1)[1].rsplit('\nPY',1)[0]
DEFINITIONS=SOURCE.rsplit('\ntry:\n    sys.exit(main())',1)[0]
class CleanupTests(unittest.TestCase):
    def execute(self, status='completed', error=False, body=None, identity=True, env=None):
        calls=[]
        def run(args, **kwargs):
            calls.append(args)
            self.assertEqual(args[1:3],['auth','print-identity-token'])
            return types.SimpleNamespace(stdout='synthetic-managed-identity' if identity else '',returncode=0)
        def open_request(request, **kwargs):
            calls.append(['controller',request.full_url,request.data,request.headers])
            if error: raise OSError('opaque')
            data=body if body is not None else {'ok':True,'code':'MANAGEMENT_HANDLED','status':status}
            response=io.BytesIO(json.dumps(data).encode());response.status=200
            return response
        namespace={};exec(compile(DEFINITIONS,str(PATH),'exec'),namespace)
        values={'CLEANUP_CONTROLLER_URL':'https://controller.example.invalid/function/management/scheduled','CONTROLLER_AUDIENCE':'https://controller.example.invalid/function'};values.update(env or {})
        with patch('subprocess.run',run),patch('urllib.request.build_opener',return_value=types.SimpleNamespace(open=open_request)),patch.dict('os.environ',values):
            try: result=namespace['main']()
            except Exception: result=1
        return result,calls
    def test_authenticated_scheduler_invocation_has_no_resource_deletion_or_secret_lookup(self):
        code,calls=self.execute();self.assertEqual(code,0)
        self.assertEqual(calls[0],['gcloud','auth','print-identity-token','--audiences=https://controller.example.invalid/function'])
        self.assertEqual(calls[1][2],b'{}');self.assertEqual(calls[1][1],'https://controller.example.invalid/function/management/scheduled')
        self.assertFalse(any('compute' in c or 'secrets' in c or 'delete' in c for c in calls))
    def test_unknown_and_preserved_controller_outcomes_fail_closed(self):
        for status in ['preserved','unknown','retired','disabled','denied']:
            code,calls=self.execute(status=status);self.assertEqual(code,1);self.assertEqual(len(calls),2)
    def test_transport_and_identity_failure_never_fall_back_to_management_credentials(self):
        for options in [{'error':True},{'identity':False},{'body':{}},{'body':{'ok':False}}]:
            code,calls=self.execute(**options);self.assertEqual(code,1)
            self.assertFalse(any('secrets' in c or 'compute' in c for c in calls))
    def test_unsafe_endpoint_and_audience_rejected_before_any_provider_command(self):
        for env in [{'CLEANUP_CONTROLLER_URL':'http://controller.example.invalid/management/scheduled'},{'CLEANUP_CONTROLLER_URL':'https://evil@controller.example.invalid/management/scheduled'},{'CLEANUP_CONTROLLER_URL':'https://controller.example.invalid/management/scheduled?x=1'},{'CONTROLLER_AUDIENCE':'https://other.example.invalid'}]:
            code,calls=self.execute(env=env);self.assertEqual(code,1);self.assertEqual(calls,[])
    def test_oversized_or_invalid_controller_body_preserves_resources(self):
        code,_=self.execute(body={'ok':True,'code':'MANAGEMENT_HANDLED','status':'completed','oversized':'x'*5000});self.assertEqual(code,1)
if __name__=='__main__':unittest.main()
