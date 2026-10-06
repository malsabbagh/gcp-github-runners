"""Offline production-script regressions. Every external command is a fixture.
Filesystem paths alone are relocated into TemporaryDirectory; shell bodies run intact.
"""
import json, os, pathlib, subprocess, sys, tempfile, unittest
ROOT = pathlib.Path(__file__).resolve().parents[2]
MOCK = r'''#!/usr/local/bin/python3
import json, os, pathlib, subprocess, sys
root=pathlib.Path(os.environ['FIXTURE_ROOT']); file=root/'state.json'; state=json.loads(file.read_text())
command=pathlib.Path(sys.argv[0]).name; args=sys.argv[1:]
with (root/'calls.jsonl').open('a') as f: f.write(json.dumps([command,*args])+'\n')
def save(): file.write_text(json.dumps(state))
if command=='sed':
 if state.get('sed_failure') and '/^RUNNER_ID_' in args[0]: sys.exit(1)
 sys.exit(subprocess.run(['/usr/bin/sed',*args]).returncode)
if command=='curl':
 url=next((a for a in args if a.startswith('http')), '')
 body=''; status='200'
 if 'metadata.google' in url:
  key=url.split('/instance/')[-1]; body={'name':'vm','id':'12345','zone':'projects/test/zones/test-a','attributes/repo-owner':'owner','attributes/repo-name':'repo'}.get(key,'')
 elif '/actions/runners?' in url:
  page=int(url.split('page=')[-1]); runners=state.get('runners',[])
  body=json.dumps({'total_count':len(runners),'runners':runners[(page-1)*100:page*100]}, indent=2)
  if state.get('malformed'): body='{"message":"no access"}'
  status=str(state.get('list_status',200))
 elif '/actions/runners/' in url:
  ident=int(url.rsplit('/',1)[-1]); status=str(state.get('delete_status',204))
  if state.get('fail_once'): state['fail_once']=False; status='500'
  if status in ('204','404'): state['runners']=[r for r in state['runners'] if r['id']!=ident]
  save()
 if '-o' in args:
  output=args[args.index('-o')+1]
  if output!='/dev/null': pathlib.Path(output).write_text(body)
 if '-w' in args: print(status,end='')
 elif '-o' not in args: print(body,end='')
 sys.exit(0)
if command=='gcloud':
 if args[:3]==['secrets','versions','access']: print('synthetic-offline-token')
 sys.exit(0)
if command=='flock': sys.exit(state.get('lock_failure',0))
if command=='id': sys.exit(0 if len(args)>1 else 1)
if command=='userdel': sys.exit(state.get('userdel_status',0))
if command=='docker':
 if args[0]=='ps': print('\n'.join(state.get('containers',[])))
 if args[0]=='inspect':
  if state.get('inspect_once'): state['inspect_once']=False; save(); sys.exit(1)
  if state.get('daemon_error'): sys.exit(1)
  if args[-1] not in state.get('containers',[]): sys.exit(1)
  print(json.dumps([{'Config':{'Env':['RUNNER_NAME=vm-runner-1']}}]))
 if args[0]=='rm': state['containers'].remove(args[-1]); save()
 sys.exit(0)
if command=='sudo':
 # Native svc stop/uninstall failure is intentional, remote removal must survive.
 sys.exit(1)
sys.exit(0)
'''
class ShutdownTests(unittest.TestCase):
 def setup_fixture(self, mode='docker', manifest=True, **state):
  temp=tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup); root=pathlib.Path(temp.name)
  for d in ['bin','log','run','home/runner-a-1/actions-runner','etc/sudoers.d']: (root/d).mkdir(parents=True)
  defaults={'runners':[{'id':1,'name':'vm-runner-1','busy':False}],'containers':['container-1']};defaults.update(state)
  (root/'state.json').write_text(json.dumps(defaults)); (root/'calls.jsonl').write_text('')
  for command in ['curl','gcloud','docker','id','userdel','flock','sudo','sed']:
   path=root/'bin'/command;path.write_text(MOCK.replace("#!/usr/local/bin/python3", "#!"+sys.executable));path.chmod(0o755)
  (root/'log/github-pat.txt').write_text('synthetic-offline-token')
  if manifest:
   (root/'log/runner-users.txt').write_text('REPO_OWNER="owner"\nREPO_NAME="repo"\nRUNNER_NAME_1="vm-runner-1"\nRUNNER_USER_1="runner-a-1"\nCONTAINER_NAME_1="container-1"\n')
  filename='runner-shutdown-multi-user-docker.sh' if mode=='docker' else 'runner-shutdown-multi-user.sh'
  text=(ROOT/'cloudbuild'/filename).read_text()
  for old,new in [('/var/log',str(root/'log')),('/var/run',str(root/'run')),('/home/',str(root/'home')+'/'),('/etc/sudoers.d',str(root/'etc/sudoers.d'))]:text=text.replace(old,new)
  script=root/'shutdown.sh';script.write_text(text)
  env=dict(os.environ,PATH=str(root/'bin')+':'+os.environ['PATH'],FIXTURE_ROOT=str(root))
  return root,script,env
 def run_fixture(self, fixture):
  root,script,env=fixture; result=subprocess.run(['bash','-c','source "$1"; shutdown_main','fixture',str(script)],env=env,capture_output=True,text=True,timeout=10)
  calls=[json.loads(l) for l in (root/'calls.jsonl').read_text().splitlines()]
  return result,calls
 def test_formatted_second_page_exact_identity(self):
  rows=[{'id':n+10,'name':'unrelated-'+str(n),'busy':False} for n in range(100)]+[{'id':1,'name':'vm-runner-1','busy':False}]
  f=self.setup_fixture(runners=rows);result,calls=self.run_fixture(f)
  self.assertEqual(result.returncode,0,result.stdout+result.stderr)
  self.assertTrue(any('page=2' in ' '.join(c) for c in calls))
  deletes=[c[-1] for c in calls if c[0]=='curl' and 'DELETE' in c]
  self.assertEqual(deletes,['https://api.github.com/repos/owner/repo/actions/runners/1'])
  self.assertIn('RUNNER_ID_1="1"',(f[0]/'log/runner-users.txt').read_text())
 def test_remote_failure_retains_state_then_retry_succeeds(self):
  f=self.setup_fixture(fail_once=True);result,calls=self.run_fixture(f)
  self.assertEqual(result.returncode,1);self.assertFalse(any(c[0]=='userdel' for c in calls))
  self.assertTrue((f[0]/'log/runner-users.txt').exists());self.assertTrue((f[0]/'log/github-pat.txt').exists())
  result,_=self.run_fixture(f);self.assertEqual(result.returncode,0,result.stdout+result.stderr)
 def test_busy_preserves_local_resources_and_no_completion(self):
  f=self.setup_fixture(runners=[{'id':1,'name':'vm-runner-1','busy':True}]);result,calls=self.run_fixture(f)
  self.assertEqual(result.returncode,1);self.assertFalse(any('DELETE' in c or c[0]=='userdel' or (c[0]=='docker' and c[1]=='stop') for c in calls))
 def test_http_error_and_schema_error_are_not_absence(self):
  for state in [{'list_status':403},{'malformed':True}]:
   f=self.setup_fixture(**state);result,calls=self.run_fixture(f);self.assertEqual(result.returncode,1)
   self.assertFalse(any('DELETE' in c or c[0]=='userdel' for c in calls))
 def test_empty_valid_inventory_is_idempotent(self):
  f=self.setup_fixture(runners=[]);result,calls=self.run_fixture(f);self.assertEqual(result.returncode,0,result.stdout+result.stderr)
  self.assertFalse(any('DELETE' in c for c in calls))
 def test_missing_manifest_fallback_exact_match_and_retry(self):
  f=self.setup_fixture(manifest=False,fail_once=True,runners=[{'id':1,'name':'vm-runner-1','busy':False},{'id':2,'name':'vm-other-runner-1','busy':False},{'id':3,'name':'vm2-runner-1','busy':False}])
  result,calls=self.run_fixture(f);self.assertEqual(result.returncode,1)
  self.assertNotIn('command not found',result.stderr)
  self.assertIn('CONTAINER_NAME_1="container-1"',(f[0]/'log/runner-users.txt').read_text())
  # Unknown near-prefix registration blocks completion but is never deleted.
  result,calls=self.run_fixture(f);self.assertEqual(result.returncode,1)
  self.assertEqual([c[-1] for c in calls if 'DELETE' in c],['https://api.github.com/repos/owner/repo/actions/runners/1']*2)
 def test_missing_manifest_inspect_failure_then_retry_recovers_mapping(self):
  f=self.setup_fixture(manifest=False,inspect_once=True);result,calls=self.run_fixture(f)
  self.assertEqual(result.returncode,1);self.assertFalse(any('DELETE' in c for c in calls))
  result,calls=self.run_fixture(f);self.assertEqual(result.returncode,0,result.stdout+result.stderr)
  self.assertTrue(any(c[:2]==['docker','rm'] for c in calls))
 def test_docker_daemon_error_blocks_local_success_and_completion(self):
  f=self.setup_fixture(daemon_error=True);result,calls=self.run_fixture(f)
  self.assertEqual(result.returncode,1)
  self.assertNotIn('CLEANUP_COMPLETE="yes"',(f[0]/'log/runner-users.txt').read_text())
  self.assertFalse(any(c[0]=='gcloud' and 'add-metadata' in c for c in calls))
 def test_native_missing_service_still_removes_and_reports_remote_failure(self):
  f=self.setup_fixture(mode='native');result,calls=self.run_fixture(f)
  self.assertEqual(result.returncode,0,result.stdout+result.stderr)
  self.assertEqual(len([c for c in calls if c[0]=='sudo']),2)
  self.assertTrue(any('DELETE' in c for c in calls))
  f=self.setup_fixture(mode='native',delete_status=500);result,calls=self.run_fixture(f)
  self.assertEqual(result.returncode,1);self.assertFalse(any(c[0]=='userdel' for c in calls))
 def test_legacy_native_user_only_manifest_recovers_registration(self):
  f=self.setup_fixture(mode='native',runners=[{'id':1,'name':'vm-abcdef12-1','busy':False}])
  (f[0]/'log/runner-users.txt').write_text('REPO_OWNER="owner"\nREPO_NAME="repo"\nRUNNER_USER_1="runner-a-1"\n')
  (f[0]/'home/runner-a-1/actions-runner/.runner').write_text(json.dumps({'agentId':1,'agentName':'vm-abcdef12-1'}))
  result,calls=self.run_fixture(f);self.assertEqual(result.returncode,0,result.stdout+result.stderr)
  self.assertTrue(any('DELETE' in c for c in calls));self.assertEqual(len([c for c in calls if c[0]=='sudo']),2)
 def test_foreign_native_config_cannot_delete_or_teardown(self):
  f=self.setup_fixture(mode='native',runners=[{'id':2,'name':'other-vm-runner-1','busy':False}])
  (f[0]/'log/runner-users.txt').write_text('REPO_OWNER="owner"\nREPO_NAME="repo"\nRUNNER_USER_1="runner-a-1"\n')
  (f[0]/'home/runner-a-1/actions-runner/.runner').write_text(json.dumps({'agentId':2,'agentName':'other-vm-runner-1'}))
  result,calls=self.run_fixture(f);self.assertEqual(result.returncode,1)
  self.assertFalse(any('DELETE' in c or c[0] in ['sudo','userdel'] for c in calls))
 def test_manifest_rewrite_preserves_nonmatching_regex_like_key(self):
  f=self.setup_fixture();path=f[0]/'log/runner-users.txt'
  with path.open('a') as out:out.write('RUNNER_NAME.1="sentinel"\n')
  result,_=self.run_fixture(f);self.assertEqual(result.returncode,0,result.stdout+result.stderr)
  self.assertIn('RUNNER_NAME.1="sentinel"',path.read_text())
 def test_local_failure_prevents_success_and_retains_manifest(self):
  f=self.setup_fixture(mode='native',userdel_status=1);result,_=self.run_fixture(f)
  self.assertEqual(result.returncode,1);self.assertTrue((f[0]/'log/runner-users.txt').exists())
 def test_manifest_persistence_failure_preserves_original_and_prevents_delete(self):
  f=self.setup_fixture(sed_failure=True); original=(f[0]/'log/runner-users.txt').read_bytes()
  result,calls=self.run_fixture(f); self.assertEqual(result.returncode,1)
  self.assertEqual((f[0]/'log/runner-users.txt').read_bytes(),original)
  self.assertFalse(any('DELETE' in c or c[0]=='userdel' for c in calls))
 def test_lock_denial_does_not_touch_remote_or_local_state(self):
  f=self.setup_fixture(lock_failure=1);result,calls=self.run_fixture(f)
  self.assertEqual(result.returncode,1);self.assertFalse(any(c[0] in ['curl','docker','userdel'] for c in calls))

if __name__=='__main__': unittest.main()
