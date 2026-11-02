'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {configuration,python}=require('./integration/python-process.cjs');
const environment=()=>({PATH:'/synthetic/bin',HOME:'/synthetic/home',
  LOCAL_FIRESTORE_PYTHON:'/synthetic/python3',FIRESTORE_EMULATOR_HOST:'127.0.0.1:18080',
  GOOGLE_CLOUD_PROJECT:'demo-gcp-runner-local',FIRESTORE_DATABASE_ID:'runner-local-state'});
function childFixture() {
  const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();
  child.stdin=new EventEmitter();child.stdin.end=body=>{child.input=JSON.parse(body);};
  child.signals=[];child.kill=signal=>{child.signals.push(signal);return true;};return child;
}
test('Python child independently rejects credentials, target drift, live controls and relative interpreters',()=>{
  for(const changes of [{GOOGLE_APPLICATION_CREDENTIALS:'synthetic'},
    {CLOUDSDK_AUTH_ACCESS_TOKEN:'synthetic'},{FIRESTORE_EMULATOR_HOST:''},
    {GOOGLE_CLOUD_PROJECT:'other-project'},{FIRESTORE_DATABASE_ID:'other-db'},
    {DISPATCH_ENABLED:'true'},{SCHEDULER_PAUSED:'false'},
    {LOCAL_FIRESTORE_PYTHON:'python3'},{LOCAL_FIRESTORE_PYTHON:undefined}])
    assert.throws(()=>configuration({...environment(),...changes}));
});
test('Python child reconstructs an allowlisted environment and uses the launcher interpreter',async()=>{
  const child=childFixture();let invocation;
  const promise=python('increment',{key:'fixture'},{environment:{...environment(),
    HTTPS_PROXY:'synthetic',NODE_OPTIONS:'synthetic',CLOUDSDK_CONFIG:'synthetic',
    FIRESTORE_PREFER_REST:'synthetic',TF_VAR_project_id:'synthetic',GOOGLE_CREDENTIALS:''},
    spawnProcess:(...args)=>{invocation=args;return child;}});
  assert.equal(invocation[0],'/synthetic/python3');
  assert.deepEqual(invocation[1],['-B','tests/integration/python-pool-driver.py']);
  const env=invocation[2].env;
  for(const key of ['HTTPS_PROXY','NODE_OPTIONS','CLOUDSDK_CONFIG','FIRESTORE_PREFER_REST',
    'TF_VAR_project_id','GOOGLE_CREDENTIALS','LOCAL_FIRESTORE_PYTHON'])assert.equal(Object.hasOwn(env,key),false);
  assert.equal(env.FIRESTORE_EMULATOR_HOST,'127.0.0.1:18080');
  assert.equal(env.SCHEDULER_PAUSED,'true');assert.equal(env.DISPATCH_ENABLED,'false');
  assert.deepEqual(child.input,{operation:'increment',key:'fixture'});
  child.stdout.emit('data','{"value":1}');child.emit('close',0,null);
  assert.deepEqual(await promise,{value:1});
});
test('Python child waits for closed stdio before parsing JSON',async()=>{
  const child=childFixture();let settled=false;
  const promise=python('roundtrip',{}, {environment:environment(),spawnProcess:()=>child});
  promise.finally(()=>{settled=true;});
  child.stdout.emit('data','{"value":');child.emit('exit',0,null);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);
  child.stdout.emit('data','true}');child.emit('close',0,null);
  assert.deepEqual(await promise,{value:true});
});
test('production and retained legacy operations pass the fixed bridge while unknown operations never spawn',async()=>{
  for(const operation of ['initialize','roundtrip','increment','waiting','roundtrip-batch',
    'increment-batch','waiting-batch','roundtrip-legacy-get','increment-legacy-get','waiting-legacy-get']) {
    const child=childFixture();
    const promise=python(operation,{}, {environment:environment(),spawnProcess:()=>child});
    assert.equal(child.input.operation,operation);
    child.stdout.emit('data','true');child.emit('close',0,null);
    assert.equal(await promise,true);
  }
  assert.throws(()=>python('arbitrary-operation',{}, {environment:environment(),
    spawnProcess:()=>{assert.fail('Unknown operation must not spawn');}}),/Unknown fixed/);
});
test('Python spawn failures and signal exits reject after close with explicit diagnostics',async()=>{
  for(const mode of ['spawn','signal','invalid-json']) {
    const child=childFixture();const promise=python('waiting',{},
      {environment:environment(),spawnProcess:()=>child});
    if(mode==='spawn')child.emit('error',Error('synthetic spawn failure'));
    if(mode==='invalid-json')child.stdout.emit('data','invalid');
    child.emit('close',mode==='invalid-json'?0:null,mode==='signal'?'SIGTERM':null);
    await assert.rejects(promise,mode==='spawn'?/spawnFailed=true/:mode==='signal'?/signal=SIGTERM/:/invalid JSON/);
  }
  await assert.rejects(python('roundtrip',{}, {environment:environment(),
    spawnProcess:()=>{throw Error('synthetic');}}),/could not start/);
});
test('Python child timeout escalates and reaps before rejecting',async()=>{
  const child=childFixture();
  child.kill=signal=>{child.signals.push(signal);if(signal==='SIGKILL')queueMicrotask(()=>child.emit('close',null,signal));return true;};
  const promise=python('roundtrip',{}, {environment:environment(),spawnProcess:()=>child,
    timeoutMs:10,killGraceMs:10});
  await assert.rejects(promise,/signal=SIGKILL, timedOut=true/);
  assert.deepEqual(child.signals,['SIGTERM','SIGKILL']);
});
test('Python stdin failure terminates and closes the child instead of leaking a process',async()=>{
  const child=childFixture();
  child.kill=signal=>{child.signals.push(signal);queueMicrotask(()=>child.emit('close',null,signal));return true;};
  const promise=python('roundtrip',{}, {environment:environment(),spawnProcess:()=>child});
  child.stdin.emit('error',Error('synthetic closed pipe'));
  await assert.rejects(promise,/inputFailed=true/);assert.deepEqual(child.signals,['SIGTERM']);
});
test('Python late stdin error after close cannot restart termination or change the settled result',async()=>{
  const child=childFixture();
  const promise=python('roundtrip',{}, {environment:environment(),spawnProcess:()=>child});
  child.stdout.emit('data','true');child.emit('close',0,null);
  assert.equal(await promise,true);
  child.stdin.emit('error',Error('synthetic late pipe error'));
  assert.deepEqual(child.signals,[]);
});
test('real ENOENT spawn settles through close without a fabricated child event', {timeout:2000}, async()=>{
  await assert.rejects(python('roundtrip',{}, {environment:{...environment(),
    LOCAL_FIRESTORE_PYTHON:'/nonexistent-local-state-fixture/python3'}}),/spawnFailed=true/);
});
