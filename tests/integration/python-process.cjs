'use strict';
const {spawn} = require('node:child_process');
const {isAbsolute} = require('node:path');

const target = Object.freeze({FIRESTORE_EMULATOR_HOST:'127.0.0.1:18080',
  GOOGLE_CLOUD_PROJECT:'demo-gcp-runner-local',FIRESTORE_DATABASE_ID:'runner-local-state'});
const flags = ['WEBHOOK_ENABLED','MANAGEMENT_ENABLED','SCHEDULED_ENABLED',
  'JIT_PROVIDER_LIFETIME_QUALIFIED','APPROVED_QUIESCENCE','DISPATCH_ENABLED',
  'WORKER_DRAIN_QUALIFIED','WORKER_STOP_QUALIFIED'];
function configuration(environment) {
  for(const key of ['GOOGLE_APPLICATION_CREDENTIALS','GOOGLE_CREDENTIALS',
    'CLOUDSDK_AUTH_ACCESS_TOKEN','CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE'])
    if(environment[key])throw Error('Ambient cloud credentials are not allowed');
  if(Object.entries(target).some(([key,value])=>environment[key]!==value))
    throw Error('Explicit synthetic loopback target required');
  if(flags.some(key=>(environment[key]??'false')!=='false') ||
      (environment.SCHEDULER_PAUSED??'true')!=='true')
    throw Error('Deployment readiness must remain disabled and recovery paused');
  const executable=environment.LOCAL_FIRESTORE_PYTHON;
  if(typeof executable!=='string'||!isAbsolute(executable))
    throw Error('Use the absolute Python interpreter supplied by the launcher');
  const env=Object.fromEntries(Object.entries(environment).filter(([key])=>
    ['PATH','HOME','TMPDIR','LANG','LC_ALL'].includes(key)));
  Object.assign(env,target,{PYTHONDONTWRITEBYTECODE:'1',SCHEDULER_PAUSED:'true'});
  for(const key of flags)env[key]='false';
  return {executable,env};
}

function python(operation, values={}, {environment=process.env,spawnProcess=spawn,
  timeoutMs=45000,killGraceMs=1000}={}) {
  const {executable,env}=configuration(environment);
  if(!['initialize','roundtrip','increment','waiting','roundtrip-batch','increment-batch','waiting-batch',
    'roundtrip-legacy-get','increment-legacy-get','waiting-legacy-get'].includes(operation))
    throw Error('Unknown fixed integration operation');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||!Number.isSafeInteger(killGraceMs)||killGraceMs<1)
    throw Error('Invalid local child timeout');
  return new Promise((resolve,reject)=>{
    let child;
    try {child=spawnProcess(executable,['-B','tests/integration/python-pool-driver.py'],
      {env,stdio:['pipe','pipe','pipe']});}
    catch {reject(Error('Python adapter could not start'));return;}
    let out='',err='',spawnFailed=false,inputFailed=false,timedOut=false,terminating=false,closed=false,escalation;
    const terminate=()=>{
      if(terminating||closed)return;
      terminating=true;
      try {child.kill('SIGTERM');}catch {}
      escalation=setTimeout(()=>{try {child.kill('SIGKILL');}catch {}},killGraceMs);
    };
    const timer=setTimeout(()=>{timedOut=true;terminate();},timeoutMs);
    child.stdout.on('data',data=>{out+=data;});
    child.stderr.on('data',data=>{err+=data;});
    child.on('error',()=>{spawnFailed=true;});
    child.stdin.on('error',()=>{if(!closed){inputFailed=true;terminate();}});
    // close follows exit/error and all output streams; parsing on exit can
    // truncate the final JSON chunk. The owned child is reaped before settling.
    child.once('close',(code,signal)=>{
      closed=true;
      clearTimeout(timer);clearTimeout(escalation);
      if(spawnFailed||inputFailed||timedOut||code!==0||signal) {
        reject(Error(`Python adapter failed (code=${code}, signal=${signal??'none'}, timedOut=${timedOut}, spawnFailed=${spawnFailed}, inputFailed=${inputFailed}): ${err}`));
        return;
      }
      try {resolve(JSON.parse(out));}catch {reject(Error('Python adapter returned invalid JSON'));}
    });
    child.stdin.end(JSON.stringify({operation,...values}));
  });
}
module.exports={configuration,python};
