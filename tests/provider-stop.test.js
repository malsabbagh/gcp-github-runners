'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./fixtures/lifecycle-fixture');
const {createRetirementController}=require('../cloud-functions/cleanup-function/retirement-controller');
const controller=(f,options={})=>createRetirementController({firestore:f.firestore,compute:f.compute,runnerAdapter:f.runnerAdapter,projectId:f.entry.project,repositoryOwner:f.event.repo_owner,repositoryName:f.event.repo_name,approvedQuiescence:true,workerStopQualified:true,...options});
test('completed ephemeral runner with verified local stop is stopped once then retired and capacity released',async()=> {
  const f=fixture({runnerAbsent:true});f.acknowledgeLifecycle();
  assert.equal((await controller(f).retireAllocation(f.request)).status,'retired');
  assert.equal(f.calls.filter(x=>x==='stop').length,1);assert.equal(f.calls.filter(x=>x==='delete').length,1);assert.equal(f.getEntry(),undefined);assert.equal(JSON.parse(f.job.cleanup).instanceAbsent,true);assert.equal(f.job.lifecycle,undefined);assert.equal(f.job.providerStop,undefined);assert.equal(JSON.parse(f.job.cleanup).allocation.providerStop.state,'consumed');
});
test('disabled qualification, absent ack, changed signed completion or incarnation never stops',async()=> {
  for(const variant of ['quiescence','qualification','ack','completion','vm','busy']) {
    const f=fixture();f.acknowledgeLifecycle();const options={};
    if(variant==='quiescence')options.approvedQuiescence=false;
    if(variant==='qualification')options.workerStopQualified=false;
    if(variant==='ack'){const e=f.getEntry();e.lifecycle.stop.dispatch.acknowledgement.authenticated=false;f.setEntry(e);f.job.lifecycle=JSON.stringify(e.lifecycle);}
    if(variant==='completion')f.job.completion=JSON.stringify({...JSON.parse(f.job.completion),extra:'changed'});
    if(variant==='vm')f.getVm().id='999';
    if(variant==='busy')f.setRunners([{id:77,name:f.name,busy:true,labels:[]}]);
    assert.equal((await controller(f,options).retireAllocation(f.request)).status,'preserved');assert.equal(f.calls.includes('stop'),false);assert.ok(f.getEntry());
  }
});
test('ambiguous stop response retains consumed operation, never resends, and recovers exact terminated readback',async()=> {
  const f=fixture({runnerAbsent:true});f.acknowledgeLifecycle();f.compute.stop=async()=>{f.calls.push('stop');throw Error('lost response');};const c=controller(f);
  assert.equal((await c.retireAllocation(f.request)).status,'preserved');assert.equal(f.getEntry().providerStop.state,'consumed');
  assert.equal((await c.retireAllocation(f.request)).status,'preserved');assert.equal(f.calls.filter(x=>x==='stop').length,1);
  f.getVm().status='TERMINATED';assert.equal((await c.retireAllocation(f.request)).status,'retired');assert.equal(f.calls.filter(x=>x==='stop').length,1);
});
test('async stop readback waits for termination and replacement cannot be deleted',async()=> {
  const f=fixture({runnerAbsent:true});f.acknowledgeLifecycle();f.compute.stop=async()=>{f.calls.push('stop');f.getVm().status='STOPPING';};const c=controller(f);
  assert.equal((await c.retireAllocation(f.request)).status,'preserved');assert.equal((await c.retireAllocation(f.request)).status,'preserved');assert.equal(f.calls.filter(x=>x==='stop').length,1);
  f.getVm().id='replacement';f.getVm().status='TERMINATED';assert.equal((await c.retireAllocation(f.request)).status,'preserved');assert.equal(f.calls.includes('delete'),false);
});
test('concurrent terminal retirements consume at most one provider stop',async()=> {
  const f=fixture({runnerAbsent:true});f.acknowledgeLifecycle();const c=controller(f);await Promise.all([c.retireAllocation(f.request),c.retireAllocation(f.request)]);assert.equal(f.calls.filter(x=>x==='stop').length,1);
});
test('dispatcher accepts fully observed ephemeral absence after exact signed terminal binding',async()=> {
  const {createLifecycleDispatcher}=require('../cloud-functions/cleanup-function/lifecycle-dispatcher');
  const f=fixture({runnerAbsent:true});const retirement=controller(f);assert.equal((await retirement.requestDrain(f.request)).status,'intent_recorded');
  const workerControl={requestDrain:async op=>({...op,authenticated:true,incarnationFenced:true,state:'drained'}),inspectOperation:async()=>null};
  const d=createLifecycleDispatcher({firestore:f.firestore,compute:f.compute,runnerAdapter:f.runnerAdapter,workerControl,projectId:f.entry.project,repositoryOwner:f.event.repo_owner,repositoryName:f.event.repo_name,dispatchEnabled:true,workerDrainQualified:true,workerStopQualified:true,approvedQuiescence:true});
  assert.equal((await d.dispatchIntent({...f.request,phase:'drain'})).status,'acknowledged');
  assert.equal(f.calls.includes('stop'),false);
});
