"""Execute the actual Python reaper with gcloud and HTTP fully intercepted."""
import copy, io, json, pathlib, types, unittest
from unittest.mock import patch
ROOT=pathlib.Path(__file__).resolve().parents[2]
SOURCE=(ROOT/'cloudbuild/runner-cleanup.sh').read_text().split("python3 - <<'PY'\n",1)[1].rsplit('\nPY',1)[0]
DEFINITIONS=SOURCE.rsplit('\ntry:\n    sys.exit(main())',1)[0]
def vm(**changes):
 item={'name':'vm','id':'12345','status':'TERMINATED','zone':'projects/test/zones/test-a','creationTimestamp':'2000-01-01T00:00:00Z','labels':{'purpose':'github-runner'},'metadata':{'items':[{'key':'runner-cleanup-ready','value':'12345'},{'key':'repo-owner','value':'owner'},{'key':'repo-name','value':'repo'}]}}
 item.update(changes); return item
class CleanupTests(unittest.TestCase):
 def execute(self, machines, rows=None, changed=None, malformed=False, delete_failure=False):
  calls=[]
  def run(args,**kwargs):
   calls.append(args)
   if args[1:4]==['compute','instances','list']: out=json.dumps(machines)
   elif args[1:4]==['compute','instances','describe']: out=json.dumps(changed or machines[0])
   elif args[1:4]==['secrets','versions','access']: out='synthetic-offline-token'
   else: out=''
   return types.SimpleNamespace(stdout=out,returncode=int(delete_failure and args[1:4]==['compute','instances','delete']))
  def urlopen(request,**kwargs):
   calls.append(['http',request.full_url]); page=int(request.full_url.rsplit('page=',1)[-1]); runners=rows or []
   response=io.BytesIO(json.dumps({'message':'no access'} if malformed else {'total_count':len(runners),'runners':runners[(page-1)*100:page*100]}).encode());response.status=200;return response
  namespace={};exec(compile(DEFINITIONS,str(ROOT/'cloudbuild/runner-cleanup.sh'),'exec'),namespace)
  with patch('subprocess.run',run),patch('urllib.request.urlopen',urlopen),patch.dict('os.environ',{'REGION':'','MAX_AGE_HOURS':'2'}):
   code=namespace['main']()
  return code,calls
 def test_busy_and_idle_running_vms_survive_without_remote_requests(self):
  for status in ['RUNNING','STAGING','STOPPING','UNKNOWN']:
   code,calls=self.execute([vm(status=status)])
   self.assertFalse(code);self.assertEqual(len(calls),1)
 def test_completed_terminated_vm_deleted_without_stop(self):
  code,calls=self.execute([vm()]);self.assertFalse(code)
  self.assertEqual(len([c for c in calls if c[1:4]==['compute','instances','delete']]),1)
  self.assertFalse(any('stop' in c for c in calls))
 def test_missing_and_stale_incarnation_proof_survive(self):
  for proof in ['', '54321']:
   item=vm();item['metadata']['items'][0]['value']=proof
   _,calls=self.execute([item]);self.assertEqual(len(calls),1)
 def test_matching_registration_on_page_two_preserves_vm(self):
  rows=[{'id':n+1,'name':'other-'+str(n),'busy':False} for n in range(100)]+[{'id':101,'name':'vm-runner-1','busy':True}]
  _,calls=self.execute([vm()],rows=rows)
  self.assertTrue(any('page=2' in c[-1] for c in calls));self.assertFalse(any('delete' in c for c in calls))
 def test_unknown_state_error_never_deletes(self):
  code,calls=self.execute([vm()],malformed=True)
  self.assertTrue(code);self.assertFalse(any('delete' in c for c in calls))
 def test_restarted_or_replaced_vm_survives_fresh_check(self):
  for changed in [vm(status='RUNNING'),vm(id='67890')]:
   _,calls=self.execute([vm()],changed=changed);self.assertFalse(any('delete' in c for c in calls))
 def test_delete_failure_is_reported_without_fallback(self):
  code,calls=self.execute([vm()],delete_failure=True);self.assertTrue(code)
  self.assertEqual(len([c for c in calls if 'delete' in c]),1);self.assertFalse(any('stop' in c for c in calls))
 def test_out_of_range_age_rejected_before_any_cloud_command(self):
  namespace={};exec(compile(DEFINITIONS,str(ROOT/'cloudbuild/runner-cleanup.sh'),'exec'),namespace)
  for age in ['-1','8761','9007199254740991']:
   with patch.dict('os.environ',{'MAX_AGE_HOURS':age}),patch('subprocess.run') as run:
    with self.assertRaises(ValueError):namespace['main']()
    run.assert_not_called()
 def test_bundled_function_reaper_is_identical(self):
  self.assertEqual((ROOT/'cloudbuild/runner-cleanup.sh').read_bytes(),(ROOT/'cloud-functions/cleanup-function/runner-cleanup.sh').read_bytes())
if __name__=='__main__':unittest.main()
