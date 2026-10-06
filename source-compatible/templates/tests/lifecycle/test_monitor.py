"""Run the complete generated monitor against synthetic Docker state."""
import json, os, pathlib, subprocess, sys, tempfile, unittest
ROOT=pathlib.Path(__file__).resolve().parents[2]
MONITOR=(ROOT/'cloudbuild/runner-startup-multi-user-docker.sh').read_text().split("cat > /usr/local/bin/multi-docker-runner-monitor.sh <<'EOF'\n",1)[1].split('\nEOF',1)[0]
MOCK=r'''#!/usr/local/bin/python3
import json,os,pathlib,subprocess,sys
root=pathlib.Path(os.environ['FIXTURE_ROOT']);p=root/'state.json';state=json.loads(p.read_text());command=pathlib.Path(sys.argv[0]).name;args=sys.argv[1:]
with (root/'calls.jsonl').open('a') as f:f.write(json.dumps([command,*args])+'\n')
if command=='sudo':sys.exit(subprocess.run([str(root/'bin/docker'),*args[args.index('docker')+1:]]).returncode)
if command=='sleep':
 state['cycles']=state.get('cycles',0)+1;p.write_text(json.dumps(state));sys.exit(1 if state['cycles']>=2 else 0)
if command=='flock':sys.exit(0)
if command=='docker':
 target=next((a.split('=',1)[1] for a in args if a.startswith('name=')),args[-1])
 if args[0]=='ps':
  if '-a' in args:print(state.get(target,'not found'))
  elif state.get(target) in ['running','unhealthy']:print(target)
 if args[0]=='inspect':
  if target not in state:sys.exit(1)
  if 'Health.Status' in ' '.join(args):print('unhealthy' if state[target]=='unhealthy' else 'healthy')
  else:print(state[target])
 if args[0]=='exec':sys.exit(0 if state.get(args[1])=='running' else 1)
 if args[0]=='start':state[args[-1]]='running';p.write_text(json.dumps(state))
 if args[0]=='logs':sys.exit(1)
 sys.exit(0)
'''
class MonitorTests(unittest.TestCase):
 def test_failed_health_recovers_stopped_container_and_continues_siblings(self):
  with tempfile.TemporaryDirectory() as temp:
   root=pathlib.Path(temp)
   for d in ['bin','log','run']:(root/d).mkdir()
   (root/'state.json').write_text(json.dumps({'container-1':'exited','container-2':'running','container-3':'unhealthy'}));(root/'calls.jsonl').write_text('')
   for command in ['docker','sudo','sleep','flock']:
    path=root/'bin'/command;path.write_text(MOCK.replace('#!/usr/local/bin/python3','#!'+sys.executable));path.chmod(0o755)
   (root/'log/runner-users.txt').write_text(''.join(f'RUNNER_USER_{i}="runner-{i}"\nCONTAINER_NAME_{i}="container-{i}"\n' for i in range(1,4)))
   script=root/'monitor.sh';script.write_text(MONITOR.replace('/var/log',str(root/'log')).replace('/var/run',str(root/'run')))
   env=dict(os.environ,PATH=str(root/'bin')+':'+os.environ['PATH'],FIXTURE_ROOT=temp)
   result=subprocess.run(['bash',str(script)],env=env,text=True,capture_output=True,timeout=10)
   calls=[json.loads(x) for x in (root/'calls.jsonl').read_text().splitlines()]
   self.assertNotIn('local: can only be used',result.stderr)
   self.assertEqual([c for c in calls if c[:2]==['docker','start']],[['docker','start','container-1']])
   self.assertGreaterEqual(len([c for c in calls if c[:3]==['docker','exec','container-2']]),2)
   self.assertEqual(json.loads((root/'state.json').read_text())['cycles'],2)
   self.assertIn('container-3',(root/'log/multi-docker-runner-monitor.log').read_text())
if __name__=='__main__':unittest.main()
