'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createScheduledRecovery}=require('../cloud-functions/webhook-handler/scheduled-recovery');
const authority={expectedAudience:'https://management.example.invalid',adminSubject:'admin-subject',schedulerSubject:'scheduler-subject'};
const principal={verified:true,audience:authority.expectedAudience,subject:authority.schedulerSubject,role:'scheduler'};
function fixture({enabled=true,batchSize=2,authenticateInvocation=async()=>principal}={}) {
  const keys=['a','b','c'].map(x=>x.repeat(64));
  const entry={token:'11111111-1111-4111-8111-111111111111',name:'fixture-worker',zone:'us-central1-a',project:'example-project',
    instanceId:'12345',instanceCreationTimestamp:'2026-10-05T10:00:00Z',state:'active',
    bootstrap:{claimId:'22222222-2222-4222-8222-222222222222'},lifecycle:{drain:{state:'requested'},stop:{state:'requested'}}};
  const docs=new Map([['provisioning_pools/global',{entries:JSON.stringify(Object.fromEntries(keys.map(key=>[key,entry])))}],
    ...keys.map(key=>['job_provisioning/'+key,{done:false,event:'{}',preserve:'unchanged'}])]);
  const calls=[];
  const firestore={collection:name=>({doc:id=>({key:name+'/'+id})}),runTransaction:async body=>{
    const writes=[];let writing=false;
    const result=await body({get:async ref=>{assert.equal(writing,false);const data=docs.get(ref.key);return{exists:data!==undefined,data:()=>structuredClone(data)};},
      set:(ref,data)=>{writing=true;writes.push([ref.key,structuredClone(data)]);}});
    for(const [key,data]of writes)docs.set(key,data);return result;}};
  const recovery={hydrateAllocation:async key=>{calls.push(['hydrate',key]);return{status:'hydrated'};},
    recoverAbsentAllocation:async key=>{calls.push(['recover',key]);return{status:'preserved'};}};
  const retirement={requestDrain:async request=>{calls.push(['requestDrain',request]);return{status:'intent_recorded'};},
    prepareStop:async request=>{calls.push(['prepareStop',request]);return{status:'intent_recorded'};},
    retireAllocation:async request=>{calls.push(['retire',request]);return{status:'preserved'};},
    reconcileOrphan:async request=>{calls.push(['orphan',request]);return{status:'preserved'};}};
  const dispatcher={dispatchIntent:async request=>{calls.push(['dispatch',request]);return{status:'acknowledged'};}};
  const scheduler=createScheduledRecovery({...authority,firestore,recovery,retirement,dispatcher,enabled,batchSize,authenticateInvocation});
  const setEntries=value=>docs.set('provisioning_pools/global',{entries:JSON.stringify(value)});
  return{keys,entry,docs,calls,recovery,retirement,dispatcher,scheduler,setEntries};
}
test('disabled scheduler invokes neither authenticator state nor controllers',async()=>{
  let auth=0;const f=fixture({enabled:false,authenticateInvocation:async()=>{auth++;return principal;}});
  assert.deepEqual(await f.scheduler.runScheduled({verified:true}),{status:'disabled'});assert.equal(auth,0);assert.equal(f.calls.length,0);
  assert.equal(f.docs.has('provisioning_cursors/management'),false);
});
test('disabled scheduler needs no clients or authority identifiers',async()=>{
  assert.deepEqual(await createScheduledRecovery({}).runScheduled({}),{status:'disabled'});
});
test('scheduler independently rejects unverified worker wrong subject and wrong audience',async()=>{
  for(const value of [null,{...principal,verified:false},{...principal,role:'worker'},{...principal,subject:'other'},
    {...principal,audience:'https://other.example.invalid'}]){
    const f=fixture({authenticateInvocation:async()=>value});assert.deepEqual(await f.scheduler.runScheduled({principal}),{status:'denied'});
    assert.equal(f.calls.length,0);assert.equal(f.docs.has('provisioning_cursors/management'),false);
  }
});
test('durable round robin cursor rotates all entries within bounded batches',async()=>{
  const f=fixture();await f.scheduler.runScheduled({});await f.scheduler.runScheduled({});
  assert.deepEqual(f.calls.filter(x=>x[0]==='hydrate').map(x=>x[1]),[f.keys[0],f.keys[1],f.keys[2],f.keys[0]]);
  assert.equal(f.docs.get('provisioning_cursors/management').after,f.keys[0]);
  assert.equal(f.docs.get('job_provisioning/'+f.keys[0]).preserve,'unchanged');
});
test('one failed entry cannot starve the next entry or erase canonical diagnostics',async()=>{
  const f=fixture();f.recovery.hydrateAllocation=async key=>{f.calls.push(['hydrate',key]);if(key===f.keys[0])throw Error('private-detail');return{status:'hydrated'};};
  assert.deepEqual(await f.scheduler.runScheduled({}),{status:'completed',processed:2,failures:1});
  assert.ok(f.calls.some(x=>x[0]==='retire'&&x[1].key===f.keys[1]));assert.equal(f.docs.get('job_provisioning/'+f.keys[0]).done,false);
});
test('only absent outcome delegates exact recovery; unknown incarnation never dispatches lifecycle',async()=>{
  const f=fixture();f.setEntries({[f.keys[0]]:{state:'pending',token:f.entry.token,name:f.entry.name,zone:f.entry.zone,project:f.entry.project}});
  f.recovery.hydrateAllocation=async key=>{f.calls.push(['hydrate',key]);return{status:'absent'};};
  await f.scheduler.runScheduled({});assert.deepEqual(f.calls,[['hydrate',f.keys[0]],['recover',f.keys[0]]]);
});
test('orphan selects canonical reconciliation directly without drain or stop',async()=>{
  const f=fixture();f.setEntries({[f.keys[0]]:{...f.entry,state:'orphaned'}});
  await f.scheduler.runScheduled({});assert.equal(f.calls.some(x=>x[0]==='retire'),false);
  assert.equal(f.calls.some(x=>x[0]==='dispatch'||x[0]==='requestDrain'||x[0]==='prepareStop'),false);
  assert.ok(f.calls.some(x=>x[0]==='orphan'&&x[1].key===f.keys[0]));
});
test('automatic lifecycle progression requires canonical intents and acknowledged drain before stop',async()=>{
  const f=fixture();f.setEntries({[f.keys[0]]:f.entry});await f.scheduler.runScheduled({});
  assert.deepEqual(f.calls.map(x=>x[0]),['hydrate','retire','requestDrain','dispatch','prepareStop','dispatch','retire']);
  assert.deepEqual(f.calls.filter(x=>x[0]==='dispatch').map(x=>x[1].phase),['drain','stop']);
  assert.deepEqual(Object.keys(f.calls[3][1]).sort(),['key','token','name','zone','project','instanceId','instanceCreationTimestamp','claimId','phase'].sort());
});
test('already quiescent canonical retirement closes directly without worker dispatch',async()=>{
  const f=fixture();f.setEntries({[f.keys[0]]:f.entry});f.dispatcher.dispatchIntent=null;
  f.retirement.retireAllocation=async request=>{f.calls.push(['retire',request]);f.setEntries({});return{status:'retired'};};
  assert.deepEqual(await f.scheduler.runScheduled({}),{status:'completed',processed:1,failures:0});
  assert.deepEqual(f.calls.map(x=>x[0]),['hydrate','retire']);
});
test('denied intent or uncertain drain never advances into stop or retirement',async()=>{
  for(const stage of ['intent','dispatch']){
    const f=fixture();f.setEntries({[f.keys[0]]:f.entry});
    if(stage==='intent')f.retirement.requestDrain=async()=>({status:'preserved'});
    else f.dispatcher.dispatchIntent=async request=>{f.calls.push(['dispatch',request]);return{status:'preserved'};};
    await f.scheduler.runScheduled({});assert.equal(f.calls.some(x=>x[0]==='prepareStop'),false);
    assert.equal(f.calls.filter(x=>x[0]==='retire').length,1); // Initial canonical attempt only.
  }
});
test('denied stop preparation and uncertain stop acknowledgement never retire',async()=>{
  for(const stage of ['prepareStop','stop']){
    const f=fixture();f.setEntries({[f.keys[0]]:f.entry});
    if(stage==='prepareStop')f.retirement.prepareStop=async()=>({status:'preserved'});
    else f.dispatcher.dispatchIntent=async request=>{f.calls.push(['dispatch',request]);return{status:request.phase==='drain'?'acknowledged':'preserved'};};
    await f.scheduler.runScheduled({});assert.equal(f.calls.filter(x=>x[0]==='retire').length,1);
  }
});
test('unknown recovery status cannot invoke lifecycle and does not starve the next key',async()=>{
  const f=fixture();f.recovery.hydrateAllocation=async key=>({status:key===f.keys[0]?'unknown':'hydrated'});
  assert.deepEqual(await f.scheduler.runScheduled({}),{status:'completed',processed:2,failures:1});
  assert.equal(f.calls.some(x=>x[0]==='retire'&&x[1].key===f.keys[0]),false);
  assert.equal(f.calls.some(x=>x[0]==='retire'&&x[1].key===f.keys[1]),true);
});
test('incarnation change after drain acknowledgement blocks stop and retirement',async()=>{
  const f=fixture();f.setEntries({[f.keys[0]]:f.entry});
  f.dispatcher.dispatchIntent=async request=>{f.calls.push(['dispatch',request]);f.setEntries({[f.keys[0]]:{...f.entry,instanceId:'99999'}});return{status:'acknowledged'};};
  await f.scheduler.runScheduled({});assert.equal(f.calls.some(x=>x[0]==='prepareStop'),false);
  assert.equal(f.calls.filter(x=>x[0]==='retire').length,1);
});
test('fresh post-recovery ownership replaces stale snapshot and disappeared slot is skipped',async()=>{
  const f=fixture();f.recovery.hydrateAllocation=async key=>{
    if(key===f.keys[0])f.setEntries({[f.keys[0]]:{...f.entry,instanceId:'99999'}});return{status:'hydrated'};};
  await f.scheduler.runScheduled({});const retire=f.calls.find(x=>x[0]==='retire');assert.equal(retire[1].instanceId,'99999');
  assert.equal(f.calls.filter(x=>x[0]==='retire').length,2); // Initial preserved and final attempt for the surviving slot.
});
test('corrupt cursor or pool never calls providers and retains existing evidence',async()=>{
  for(const kind of ['cursor','pool']){
    const f=fixture();if(kind==='cursor')f.docs.set('provisioning_cursors/management',{after:'bad'});
    else f.docs.set('provisioning_pools/global',{entries:'invalid'});
    assert.deepEqual(await f.scheduler.runScheduled({}),{status:'preserved'});assert.equal(f.calls.length,0);
  }
});
test('batch limits are validated without executing recovery or instantiating SDKs',()=>{
  for(const batchSize of [0,101,1.5])assert.throws(()=>fixture({batchSize}),/SCHEDULED_CONFIGURATION_INVALID/);
});
