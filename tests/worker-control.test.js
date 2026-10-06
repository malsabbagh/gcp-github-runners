'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./fixtures/lifecycle-fixture');
const {createWorkerControl}=require('../cloud-functions/webhook-handler/worker-control');
const cfg={PROJECT_ID:'example-project',DEFAULT_ZONE:'us-central1-a',WORKER_SERVICE_ACCOUNT:'worker@example-project.iam.gserviceaccount.com',WORKER_SERVICE_ACCOUNT_UNIQUE_ID:'123456789012345678901'};
const response=()=>({statusCode:0,body:null,set(){return this;},status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}});
function controlFixture(options={}) {
  const f=fixture();f.acknowledgeLifecycle();const e=f.getEntry();delete e.lifecycle.stop;e.lifecycle.drain.dispatch.state='consumed';delete e.lifecycle.drain.dispatch.acknowledgement;f.setEntry(e);f.job.lifecycle=JSON.stringify(e.lifecycle);
  const record=e.lifecycle.drain.dispatch,op={version:1,dispatchId:record.dispatchId,phase:'drain',binding:record.binding,evidenceSha256:record.evidenceSha256};
  const worker={allocationKey:f.key,reservationToken:f.entry.token,repositoryOwner:f.event.repo_owner,repositoryName:f.event.repo_name,runId:'10',jobId:'20',attempt:'1',instanceId:'12345',runnerId:77,runnerName:f.name,incarnation:f.entry.instanceCreationTimestamp};
  const identity={instanceId:'12345',incarnation:f.entry.instanceCreationTimestamp,project:cfg.PROJECT_ID,zone:cfg.DEFAULT_ZONE,name:f.name,serviceAccountEmail:cfg.WORKER_SERVICE_ACCOUNT,serviceAccountUniqueId:cfg.WORKER_SERVICE_ACCOUNT_UNIQUE_ID,checkedAtMs:100,expiresAtMs:1000};
  const control=createWorkerControl({firestore:f.firestore,verifyIdentity:async()=>identity,infrastructureConfig:cfg,repositoryOwner:f.event.repo_owner,repositoryName:f.event.repo_name,enabled:true,clock:()=>200,...options});
  const call=async(route,body,changes={})=>{const res=response(),rawBody=Buffer.from(JSON.stringify(body));await control.handle({path:'/bootstrap/worker-control/'+route,originalUrl:'/bootstrap/worker-control/'+route,method:'POST',get:()=> 'Bearer '+'a'.repeat(80),is:()=>true,body,rawBody,...changes},res);return res;};
  return {...f,control,op,worker,identity,call};
}
test('controller mailbox authenticates exact worker and derives fenced ack without releasing capacity',async()=> {
  const f=controlFixture();assert.equal(await f.control.requestDrain(f.op),null);
  assert.deepEqual((await f.call('poll',f.worker)).body,{ok:true,operation:f.op});
  assert.equal((await f.call('ack',{worker:f.worker,operation:f.op,state:'drained'})).statusCode,200);
  const ack=await f.control.inspectOperation(f.op);assert.deepEqual(ack,{...f.op,authenticated:true,incarnationFenced:true,state:'drained'});
  assert.equal((await f.call('poll',f.worker)).body.operation,null);assert.ok(f.getEntry());assert.equal(f.calls.includes('stop'),false);
  assert.deepEqual(await f.control.requestDrain(f.op),ack);assert.equal((await f.call('ack',{worker:f.worker,operation:f.op,state:'drained'})).statusCode,200);
});
test('unverified, changed or expired identity and mismatched ownership never acknowledge',async()=> {
  for(const variant of ['assertion','expiry','instance','subject','worker','operation','state','mirror']) {
    const f=controlFixture();await f.control.requestDrain(f.op);
    if(variant==='assertion')f.identity.instanceId=null;
    if(variant==='expiry')f.identity.expiresAtMs=199;
    if(variant==='instance')f.identity.incarnation='2001-01-01T00:00:00Z';
    if(variant==='subject')f.identity.serviceAccountUniqueId='999999';
    const worker=variant==='worker'?{...f.worker,runId:'99'}:f.worker;
    const operation=variant==='operation'?{...f.op,evidenceSha256:'b'.repeat(64)}:f.op;
    if(variant==='mirror')f.job.workerControl=JSON.stringify({operation:f.op,acknowledgement:{bad:true}});
    assert.ok((await f.call('ack',{worker,operation,state:variant==='state'?'stopped':'drained'})).statusCode>=400);
    assert.equal(f.getEntry().workerControl.acknowledgement,null);assert.ok(f.getEntry());
  }
});
test('control input is canonical bounded JSON on exact routes and response never leaks failures',async()=> {
  const f=controlFixture();await f.control.requestDrain(f.op);
  for(const req of [{method:'GET'},{originalUrl:'/bootstrap/worker-control/poll?x=1'},{get:()=>null},{is:()=>false},{rawBody:Buffer.alloc(17000)},{rawBody:Buffer.from(' {}')},{body:{extra:true}}]) {
    const res=await f.call('poll',f.worker,req);assert.ok(res.statusCode>=400);assert.match(res.body.code,/^WORKER_CONTROL_/);
  }
  const malformed=await f.call('ack',{worker:f.worker,operation:f.op,state:'drained',authenticated:true});assert.equal(malformed.statusCode,400);
});
test('disabled control does not authenticate read or change state; unknown operations stay preserved',async()=> {
  const f=controlFixture({enabled:false,verifyIdentity:async()=>{throw Error('must not invoke');}});assert.equal(await f.control.requestStop(f.op),null);assert.equal(await f.control.inspectOperation(f.op),null);
  assert.equal((await f.call('poll',f.worker)).statusCode,503);assert.equal(f.getEntry().workerControl,undefined);
  const active=controlFixture();await assert.rejects(active.control.requestDrain({...active.op,evidenceSha256:'c'.repeat(64)}));assert.equal(active.getEntry().workerControl,undefined);
});
test('incarnation mutation during signed verification is fenced before durable acknowledgement',async()=> {
  const f=controlFixture();await f.control.requestDrain(f.op);
  const control=createWorkerControl({firestore:f.firestore,verifyIdentity:async()=>{const e=f.getEntry();e.instanceId='99999';f.setEntry(e);return f.identity;},infrastructureConfig:cfg,repositoryOwner:f.event.repo_owner,repositoryName:f.event.repo_name,enabled:true,clock:()=>200});
  const res=response(),body={worker:f.worker,operation:f.op,state:'drained'};await control.handle({path:'/bootstrap/worker-control/ack',method:'POST',get:()=> 'Bearer '+'a'.repeat(80),is:()=>true,body,rawBody:Buffer.from(JSON.stringify(body))},res);
  assert.equal(res.statusCode,409);assert.equal(f.getEntry().workerControl.acknowledgement,null);
});
