'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {python} = require('./python-process.cjs');
const {Firestore} = require('@google-cloud/firestore');
const {coordinator, identity} = require('../../cloud-functions/webhook-handler/provisioning-state');
const {createAllocationBootstrapStore} = require('../../cloud-functions/webhook-handler/allocation-bootstrap-store');
const {createAllocationBootstrapBroker} = require('../../cloud-functions/webhook-handler/allocation-bootstrap-broker');
const {createActualJobAssociation, validatedActualCompletion} = require('../../cloud-functions/webhook-handler/actual-job-association');
const {createWaitingRecovery} = require('../../cloud-functions/webhook-handler/waiting-recovery');
const {createAllocationRecovery} = require('../../cloud-functions/webhook-handler/allocation-recovery');
if (process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:18080' ||
    process.env.GOOGLE_CLOUD_PROJECT !== 'demo-gcp-runner-local' ||
    process.env.FIRESTORE_DATABASE_ID !== 'runner-local-state') throw Error('Explicit synthetic loopback target required');
const db = new Firestore({projectId:'demo-gcp-runner-local', databaseId:'runner-local-state'});
const pool = db.doc('provisioning_pools/global');
const job = key => db.doc(`job_provisioning/${key}`);
const event = id => ({repo_owner:'example',repo_name:'fixture',run_id:'1',job_id:String(id),
  run_attempt:'1',labels:['self-hosted','fixture-route']});
const profile = {project:'demo-gcp-runner-local',zone:'us-central1-a',
  repositoryOwner:'example',repositoryName:'fixture',
  workerServiceAccountEmail:'worker@demo-gcp-runner-local.iam.gserviceaccount.com',
  workerServiceAccountUniqueId:'123456',brokerUrl:'https://synthetic.invalid/bootstrap',
  bootstrapTTLms:100000,registeredLabels:['self-hosted','fixture-route'],routingLabel:'fixture-route'};
function control(createBuild, extra={}) {
  return coordinator({...profile,firestore:db,cloudBuild:{},
    compute:{async *aggregatedListAsync(){}},limit:1,createBuild,...extra});
}
async function bootstrapFixture(id) {
  const e=event(id),key=identity(e).key,token=randomUUID();let now=100000;
  const entry={...profile,name:identity(e).name,token,state:'active',instanceId:'3',
    instanceCreationTimestamp:'2026-10-05T00:00:00.000Z',bootstrapExpiresAtMs:200000};
  await pool.set({entries:JSON.stringify({[key]:entry})});
  await job(key).set({done:false,state:'pending',event:JSON.stringify(e)});
  const store=createAllocationBootstrapStore({...profile,firestore:db,clock:()=>now});
  const request={allocationKey:key,reservationToken:token,repositoryOwner:'example',
    repositoryName:'fixture',runId:'1',jobId:String(id),attempt:'1',instanceId:'3'};
  const material={encodedJitConfig:'synthetic-only-material',runnerId:4,runnerName:entry.name,
    releaseBeforeMs:200000,providerExpiresAtMs:null};
  const broker=mintJit=>createAllocationBootstrapBroker({store,clock:()=>now,
    // This injected mock-only seam does not enable an environment readiness flag.
    jitProviderLifetimeQualified:true,github:{mintJit},verifyIdentity:async()=>({
      project:entry.project,zone:entry.zone,name:entry.name,instanceId:'3',
      incarnation:entry.instanceCreationTimestamp,serviceAccountEmail:entry.workerServiceAccountEmail,
      serviceAccountUniqueId:entry.workerServiceAccountUniqueId,checkedAtMs:now,expiresAtMs:300000})});
  return {e,key,entry,request,material,store,broker,setNow:value=>{now=value;}};
}
async function snapshot() {
  const result={};
  for(const collection of ['provisioning_pools','job_provisioning','provisioning_cursors'])
    for(const doc of (await db.collection(collection).get()).docs)result[doc.ref.path]=doc.data();
  return result;
}
async function readEntry(key) {return JSON.parse((await pool.get()).data().entries)[key];}
async function clean() {
  for (const name of ['job_provisioning','provisioning_pools','provisioning_cursors']) {
    const rows = await db.collection(name).get();
    await Promise.all(rows.docs.map(doc => doc.ref.delete()));
  }
}
test.beforeEach(clean);
test.after(async()=>{await clean();await db.terminate();});
test('JS SDK and production Python REST codec preserve strings, booleans and receipts',async()=>{
  const key=identity(event(1)).key, receipt={claimId:randomUUID(),observed:true};
  await pool.set({entries:JSON.stringify({[key]:{token:randomUUID(),receipt,count:'0'}})});
  await job(key).set({done:false,state:'waiting',note:'مرحبا 🌱',unknownEvidence:'preserve-me',count:'0',bootstrap:JSON.stringify(receipt)});
  await python('roundtrip',{key});
  const seen=(await job(key).get()).data(), entries=JSON.parse((await pool.get()).data().entries);
  assert.equal(seen.done,false);assert.equal(seen.unknownEvidence,'preserve-me');
  assert.deepEqual(JSON.parse(seen.bootstrap),receipt);
  assert.deepEqual(JSON.parse(seen.pythonReceipt),{observed:true,unicode:'مرحبا 🌱'});
  assert.equal(entries[key].pythonObserved,true);assert.deepEqual(entries[key].receipt,receipt);
});
test('batchGet comparison preserves both adapters fields without changing production GET',async()=>{
  const key=identity(event(2)).key;
  await pool.set({entries:JSON.stringify({[key]:{token:randomUUID(),count:'0'}})});
  await job(key).set({done:false,state:'waiting',note:'مرحبا 🌱',unknownEvidence:'preserve-me',count:'0'});
  await python('roundtrip-batch',{key});
  const seen=(await job(key).get()).data();
  assert.equal(seen.done,false);assert.equal(seen.unknownEvidence,'preserve-me');
  assert.deepEqual(JSON.parse(seen.pythonReceipt),{observed:true,unicode:'مرحبا 🌱'});
  assert.equal(JSON.parse((await pool.get()).data().entries)[key].pythonObserved,true);
});
test('concurrent duplicate admissions reserve one slot and submit one mocked build',async()=>{
  let submissions=0,entered,release;
  const started=new Promise(resolve=>{entered=resolve;});
  const pendingBuild=new Promise(resolve=>{release=resolve;});
  const control=coordinator({firestore:db,cloudBuild:{},compute:{async *aggregatedListAsync(){}},
    project:'demo-gcp-runner-local',zone:'us-central1-a',limit:1,
    workerServiceAccountEmail:'worker@demo-gcp-runner-local.iam.gserviceaccount.com',
    workerServiceAccountUniqueId:'123456',brokerUrl:'https://synthetic.invalid/bootstrap',
    createBuild:async()=>{submissions++;entered();await pendingBuild;return{metadata:{build:{id:'synthetic-build'}}};}});
  const a=event(10), b=event(11);
  const first=control.provision(a);
  await started;
  try {
    const duringSubmission=await Promise.all([control.provision(a),control.provision(b),control.provision(b)]);
    assert.deepEqual(duringSubmission.sort(),['capacity','capacity','submitting']);
    assert.equal(submissions,1);
  } finally {release();}
  await first;
  assert.equal(submissions,1);assert.equal(Object.keys(JSON.parse((await pool.get()).data().entries)).length,1);
  const states=(await db.collection('job_provisioning').get()).docs.map(x=>x.data().state).sort();
  assert.deepEqual(states,['pending','waiting']);
  const replay=await control.provision(a);assert.ok(['pending','capacity'].includes(replay));assert.equal(submissions,1);
});
test('both adapters commit paired pool/job changes under contention without lost updates',async()=>{
  const key=identity(event(20)).key;
  await pool.set({entries:JSON.stringify({[key]:{count:'0'}})});
  await job(key).set({done:false,state:'waiting',count:'0'});
  const js=async()=>db.runTransaction(async tx=>{
    const [p,j]=await tx.getAll(pool,job(key));const entries=JSON.parse(p.data().entries);
    const count=String(Number(j.data().count)+1);entries[key].count=count;
    tx.update(pool,{entries:JSON.stringify(entries)});tx.update(job(key),{count});
  });
  for(let round=0;round<3;round++)await Promise.all([js(),python('increment',{key})]);
  assert.equal((await job(key).get()).data().count,'6');
  assert.equal(JSON.parse((await pool.get()).data().entries)[key].count,'6');
});
test('batchGet comparison permits real cross-adapter transaction contention',async()=>{
  const key=identity(event(21)).key;await pool.set({entries:JSON.stringify({[key]:{count:'0'}})});
  await job(key).set({done:false,state:'waiting',count:'0'});
  const js=async()=>db.runTransaction(async tx=>{
    const [p,j]=await tx.getAll(pool,job(key)),entries=JSON.parse(p.data().entries);
    const count=String(Number(j.data().count)+1);entries[key].count=count;
    tx.update(pool,{entries:JSON.stringify(entries)});tx.update(job(key),{count});
  });
  for(let round=0;round<3;round++)await Promise.all([js(),python('increment-batch',{key})]);
  assert.equal((await job(key).get()).data().count,'6');
  assert.equal(JSON.parse((await pool.get()).data().entries)[key].count,'6');
});
test('SDK retries a controlled ABORTED callback and the mock effect runs once after commit',async()=>{
  const ref=job(identity(event(30)).key);await ref.set({count:'0'});
  let attempts=0,effects=0;
  await db.runTransaction(async tx=>{
    attempts++;const snapshot=await tx.get(ref);
    // A bounded application-level injection tests the real SDK retry path.
    // This is separate from the actual cross-adapter contention case above.
    if(attempts===1)throw Object.assign(Error('controlled local ABORTED'),{code:10});
    tx.update(ref,{count:String(Number(snapshot.data().count)+1)});
  },{readOnly:false,maxAttempts:5});
  effects++;
  assert.equal((await ref.get()).data().count,'1');assert.equal(effects,1);
  assert.equal(attempts,2);
});
test('concurrent broker exchanges issue one mocked JIT and retain matching durable receipts',async()=>{
  const e=event(40),key=identity(e).key,token=randomUUID(),now=100000;
  const entry={name:'fixture-worker',token,state:'active',zone:'us-central1-a',project:'demo-gcp-runner-local',
    instanceId:'3',instanceCreationTimestamp:'2026-10-05T00:00:00.000Z',
    workerServiceAccountEmail:'worker@demo-gcp-runner-local.iam.gserviceaccount.com',
    workerServiceAccountUniqueId:'123456',bootstrapExpiresAtMs:200000};
  await pool.set({entries:JSON.stringify({[key]:entry})});await job(key).set({done:false,state:'pending',event:JSON.stringify(e)});
  const store=createAllocationBootstrapStore({firestore:db,project:entry.project,zone:entry.zone,
    repositoryOwner:'example',repositoryName:'fixture',workerServiceAccountEmail:entry.workerServiceAccountEmail,
    workerServiceAccountUniqueId:entry.workerServiceAccountUniqueId,registeredLabels:e.labels,routingLabel:'fixture-route',clock:()=>now});
  let mints=0;
  const broker=createAllocationBootstrapBroker({store,clock:()=>now,jitProviderLifetimeQualified:true,
    verifyIdentity:async()=>({project:entry.project,zone:entry.zone,name:entry.name,instanceId:'3',
      incarnation:entry.instanceCreationTimestamp,serviceAccountEmail:entry.workerServiceAccountEmail,
      serviceAccountUniqueId:'123456',checkedAtMs:now,expiresAtMs:300000}),
    github:{mintJit:async()=>{mints++;return{encodedJitConfig:'synthetic-only-material',runnerId:4,
      runnerName:entry.name,releaseBeforeMs:200000,providerExpiresAtMs:null};}}});
  const request={allocationKey:key,reservationToken:token,repositoryOwner:'example',repositoryName:'fixture',runId:'1',jobId:'40',attempt:'1',instanceId:'3'};
  const responses=await Promise.all([broker.exchange(request,'synthetic'),broker.exchange(request,'synthetic')]);
  assert.equal(responses.filter(x=>x.ok).length,1);assert.equal(mints,1);
  assert.equal((await broker.exchange(request,'synthetic')).ok,false);assert.equal(mints,1);
  const saved=JSON.parse((await pool.get()).data().entries)[key];
  assert.equal(saved.bootstrap.state,'issued');assert.deepEqual(saved.bootstrap,JSON.parse((await job(key).get()).data().bootstrap));
  assert.equal(JSON.stringify(saved).includes('synthetic-only-material'),false);
});
test('cancellation and completion during an asynchronous mint retain ownership and release no material',async t=>{
  for(const action of ['cancelled','completed']) {
    const f=await bootstrapFixture(50);let calls=0,release,started;
    const barrier=new Promise(resolve=>{release=resolve;});
    const entered=new Promise(resolve=>{started=resolve;});
    const broker=f.broker(async()=>{calls++;started();await barrier;return f.material;});
    const exchange=broker.exchange(f.request,'synthetic');
    await entered;
    try {await control(async()=>assert.fail('no build expected')).complete({...f.e,action,verifiedWebhook:true});}
    finally {release();}
    assert.equal((await exchange).ok,false);
    const saved=await readEntry(f.key),demand=(await job(f.key).get()).data();
    assert.equal(saved.token,f.entry.token);assert.equal(saved.state,'active');
    assert.equal(saved.demandDone,true);assert.equal(demand.done,true);
    assert.equal(saved.bootstrap.state,'claimed');assert.equal(saved.bootstrap.runnerId,4);
    assert.deepEqual(JSON.parse(demand.bootstrap),saved.bootstrap);
    assert.equal((await broker.exchange(f.request,'synthetic')).ok,false);assert.equal(calls,1);
    assert.equal(JSON.stringify(await snapshot()).includes(f.material.encodedJitConfig),false);
    t.diagnostic(JSON.stringify({action,mintCalls:calls,release:false,chargedEntries:1,claim:saved.bootstrap.state}));
  }
});
test('uncertain mocked mint is consumed once and absence recovery retains its unknown capacity',async t=>{
  const f=await bootstrapFixture(51);let calls=0,computeCalls=0;
  const broker=f.broker(async()=>{calls++;throw Error('synthetic response lost');});
  assert.deepEqual(await broker.exchange(f.request,'synthetic'),{ok:false,code:'BOOTSTRAP_UNAVAILABLE'});
  assert.equal((await broker.exchange(f.request,'synthetic')).code,'BOOTSTRAP_REPLAY_REJECTED');
  const recovery=createAllocationRecovery({...profile,firestore:db,clock:()=>100000,
    compute:{get:async()=>{computeCalls++;throw Object.assign(Error('synthetic absent'),{code:5});}},
    cloudBuild:{getBuild:async()=>assert.fail('claimed issuance cannot release through a build read')}});
  assert.deepEqual(await recovery.recoverAbsentAllocation(f.key),
    {status:'preserved',reason:'receipt-or-association-charged'});
  const saved=await readEntry(f.key);
  assert.equal(saved.bootstrap.state,'claimed');assert.equal(saved.state,'unknown');
  assert.equal(saved.token,f.entry.token);assert.equal(calls,1);assert.equal(computeCalls,1);
  assert.deepEqual(JSON.parse((await job(f.key).get()).data().bootstrap),saved.bootstrap);
  t.diagnostic(JSON.stringify({mintCalls:calls,computeMockCalls:computeCalls,chargedEntries:1,claim:'claimed'}));
});
test('eligible job B on runner reserved for A binds atomically and delayed queue events cannot build again',async t=>{
  const f=await bootstrapFixture(60);let mints=0,builds=0;
  assert.equal((await f.broker(async()=>{mints++;return f.material;}).exchange(f.request,'synthetic')).ok,true);
  const association=createActualJobAssociation({...profile,firestore:db,clock:()=>100001});
  const actual={...event(61),verifiedWebhook:true,runner_id:4,runner_name:f.entry.name};
  const responses=await Promise.all([
    association.observe({...actual,action:'in_progress'}),
    association.observe({...actual,action:'completed'}),
    association.observe({...actual,action:'completed'})]);
  assert.ok(responses.some(r=>r.status==='completed'));
  assert.ok(responses.every(r=>['associated','completed','duplicate'].includes(r.status)));
  const before=await snapshot();
  assert.equal((await association.observe({...actual,action:'in_progress'})).status,'duplicate');
  assert.equal((await association.observe({...actual,action:'completed'})).status,'duplicate');
  assert.deepEqual(await snapshot(),before);
  const saved=await readEntry(f.key),owner=(await job(f.key).get()).data();
  const actualDemand=(await job(identity(actual).key).get()).data();
  assert.equal(saved.actualJob.key,identity(actual).key);assert.equal(saved.actualJob.state,'completed');
  assert.deepEqual(JSON.parse(owner.actualJob),saved.actualJob);
  assert.equal(JSON.parse(actualDemand.executedBy).allocationKey,f.key);
  assert.equal(JSON.parse(actualDemand.executedBy).state,'completed');
  assert.equal(validatedActualCompletion({entry:saved,job:owner}),true);
  assert.equal(owner.done,false);assert.deepEqual(JSON.parse(owner.event),f.e);
  assert.equal(await control(async()=>{builds++;}).provision({...actual,action:'queued'}),'associated');
  assert.equal(builds,0);assert.equal(mints,1);
  assert.equal(Object.keys(JSON.parse((await pool.get()).data().entries)).length,1);
  t.diagnostic(JSON.stringify({mintCalls:mints,delayedQueueBuilds:builds,actualJob:'61',reservedJob:'60',chargedEntries:1}));
});
test('SDK waiting recovery paginates, wraps and continues after one failed demand',async t=>{
  const events=Array.from({length:5},(_,i)=>({...event(70+i),action:'queued',verifiedWebhook:true}));
  for(const e of events)await job(identity(e).key).set({done:false,state:'waiting',event:JSON.stringify(e)});
  const expected=events.map(e=>identity(e).key).sort(),calls=[];
  const waiting=createWaitingRecovery({firestore:db,batchSize:2,isEligible:()=>true,
    provisioning:{provision:async e=>{calls.push(identity(e).key);if(calls.length===1)throw Error('synthetic failed item');return 'capacity';}}});
  assert.deepEqual(await waiting.recoverWaiting(),{status:'completed',processed:1,failures:1});
  assert.deepEqual(await waiting.recoverWaiting(),{status:'completed',processed:2,failures:0});
  assert.deepEqual(await waiting.recoverWaiting(),{status:'completed',processed:1,failures:0});
  assert.deepEqual(calls,expected);
  assert.deepEqual(await waiting.recoverWaiting(),{status:'completed',processed:2,failures:0});
  assert.deepEqual(calls.slice(5),expected.slice(0,2));
  assert.equal((await db.doc('provisioning_cursors/waiting-runtime').get()).data().after,expected[1]);
  t.diagnostic(JSON.stringify({pageSizes:[2,2,1,2],attempts:calls.length,failedItems:1,wrapped:true}));
});
test('Python batchGet comparison waiting cursor paginates and wraps with actual REST queries',async t=>{
  const events=Array.from({length:5},(_,i)=>({...event(80+i),action:'queued',verifiedWebhook:true}));
  for(const e of events)await job(identity(e).key).set({done:false,state:'waiting',event:JSON.stringify(e)});
  const expected=events.sort((a,b)=>identity(a).key.localeCompare(identity(b).key)).map(e=>JSON.stringify(e));
  const pages=[];
  for(let i=0;i<4;i++)pages.push((await python('waiting-batch',{page_size:2})).map(row=>row.event));
  assert.deepEqual(pages,[expected.slice(0,2),expected.slice(2,4),expected.slice(4),expected.slice(0,2)]);
  const cursor=(await db.doc('provisioning_cursors/waiting').get()).data().after;
  assert.equal(cursor,job(identity(JSON.parse(expected[1])).key).formattedName);
  t.diagnostic(JSON.stringify({adapter:'test-only batchGet',pageSizes:pages.map(p=>p.length),wrapped:true}));
});
test('original Python GET waiting cursor uses the unchanged production transport contract',async()=>{
  const e=event(90);await job(identity(e).key).set({done:false,state:'waiting',event:JSON.stringify(e)});
  const rows=await python('waiting',{page_size:2});
  assert.deepEqual(rows.map(row=>row.event),[JSON.stringify(e)]);
});
test('failed unissued build recovery atomically releases a slot and waiting demand replays once',async t=>{
  const e={...event(100),action:'queued',verifiedWebhook:true},key=identity(e).key;
  const entry={name:identity(e).name,token:randomUUID(),state:'pending',zone:profile.zone,
    project:profile.project,buildId:'synthetic-failed-build',creationStarted:false};
  await pool.set({entries:JSON.stringify({[key]:entry})});
  await job(key).set({done:false,state:'pending',event:JSON.stringify(e)});
  let gets=0,buildReads=0,builds=0;
  const recovery=createAllocationRecovery({...profile,firestore:db,clock:()=>100000,
    compute:{get:async()=>{gets++;throw Object.assign(Error('synthetic absent'),{code:5});}},
    cloudBuild:{getBuild:async()=>{buildReads++;return[{id:entry.buildId,projectId:profile.project,status:'FAILURE'}];}}});
  assert.deepEqual(await recovery.recoverAbsentAllocation(key),
    {status:'released',reason:'failed-build-and-authoritative-absence-unissued'});
  assert.equal(await readEntry(key),undefined);assert.equal((await job(key).get()).data().state,'waiting');
  assert.equal((await job(key).get()).data().event,JSON.stringify(e));
  const waiting=createWaitingRecovery({firestore:db,isEligible:()=>true,
    provisioning:control(async()=>{builds++;return{metadata:{build:{id:'synthetic-replay'}}};})});
  assert.deepEqual(await waiting.recoverWaiting(),{status:'completed',processed:1,failures:0});
  assert.deepEqual(await waiting.recoverWaiting(),{status:'completed',processed:0,failures:0});
  const saved=await readEntry(key);assert.equal(saved.state,'pending');assert.equal(saved.buildId,'synthetic-replay');
  assert.notEqual(saved.token,entry.token);assert.equal(builds,1);assert.equal(gets,2);assert.equal(buildReads,1);
  t.diagnostic(JSON.stringify({computeMockGets:gets,buildMockReads:buildReads,replayBuilds:builds,chargedEntries:1}));
});
test('malformed and missing authoritative records are preserved by real SDK transactions',async t=>{
  let cases=0;
  for(const failure of ['pool-json','pool-missing','job-missing','receipt-mirror']) {
    const f=await bootstrapFixture(110);let mints=0;
    if(failure==='pool-json')await pool.set({entries:'invalid-json',evidence:'preserve-me'});
    if(failure==='pool-missing')await pool.delete();
    if(failure==='job-missing')await job(f.key).delete();
    if(failure==='receipt-mirror')await job(f.key).update({bootstrap:'{"state":"issued"}'});
    const before=await snapshot();
    assert.equal((await f.broker(async()=>{mints++;return f.material;}).exchange(f.request,'synthetic')).ok,false);
    assert.deepEqual(await snapshot(),before);assert.equal(mints,0);cases++;
  }
  await clean();
  const e={...event(111),action:'queued',verifiedWebhook:true};
  await job(identity(e).key).set({done:false,state:'waiting',event:'{'});
  const valid={...event(112),action:'queued',verifiedWebhook:true};
  await job(identity(valid).key).set({done:false,state:'waiting',event:JSON.stringify(valid)});
  let calls=0;const waiting=createWaitingRecovery({firestore:db,isEligible:()=>true,
    provisioning:{provision:async()=>{calls++;return 'capacity';}}});
  assert.deepEqual(await waiting.recoverWaiting(),{status:'completed',processed:1,failures:1});
  assert.equal(calls,1);assert.equal((await job(identity(e).key).get()).data().event,'{');
  await db.doc('provisioning_cursors/waiting-runtime').set({after:'malformed-cursor'});
  const before=await snapshot();
  assert.deepEqual(await waiting.recoverWaiting(),{status:'preserved',processed:0,failures:1});
  assert.deepEqual(await snapshot(),before);
  t.diagnostic(JSON.stringify({bootstrapPreservedCases:cases,malformedEventRetained:true,malformedCursorRetained:true}));
});
test('ownership changed during mocked absence inspection cannot release the replacement allocation',async t=>{
  const e=event(120),key=identity(e).key,original=randomUUID(),replacement=randomUUID();
  await pool.set({entries:JSON.stringify({[key]:{name:identity(e).name,token:original,
    state:'pending',zone:profile.zone,creationStarted:false,buildId:'synthetic-failed-build'}})});
  await job(key).set({done:false,state:'pending',event:JSON.stringify(e)});
  let reads=0;
  const recovery=createAllocationRecovery({...profile,firestore:db,clock:()=>100000,
    compute:{get:async()=>{throw Object.assign(Error('synthetic absent'),{code:5});}},
    cloudBuild:{getBuild:async()=>{reads++;await db.runTransaction(async tx=>{
      const snap=await tx.get(pool),entries=JSON.parse(snap.data().entries);
      entries[key].token=replacement;tx.update(pool,{entries:JSON.stringify(entries)});
    });return[{id:'synthetic-failed-build',projectId:profile.project,status:'FAILURE'}];}}});
  assert.deepEqual(await recovery.recoverAbsentAllocation(key),{status:'preserved',reason:'ownership-changed'});
  assert.equal((await readEntry(key)).token,replacement);assert.equal((await job(key).get()).data().state,'pending');
  assert.equal(reads,1);t.diagnostic(JSON.stringify({buildMockReads:reads,replacementCharged:true}));
});
test('expiry and identity drift during mocked mint cannot release material or reset the consumed claim',async t=>{
  for(const mode of ['expiry','incarnation']) {
    const f=await bootstrapFixture(130);let calls=0;
    const broker=f.broker(async()=>{
      calls++;
      if(mode==='expiry')f.setNow(200001);
      else await db.runTransaction(async tx=>{
        const snap=await tx.get(pool),entries=JSON.parse(snap.data().entries);
        entries[f.key].instanceCreationTimestamp='2026-10-05T01:00:00.000Z';
        tx.update(pool,{entries:JSON.stringify(entries)});
      });
      return f.material;
    });
    assert.equal((await broker.exchange(f.request,'synthetic')).ok,false);
    assert.equal((await broker.exchange(f.request,'synthetic')).ok,false);assert.equal(calls,1);
    const saved=await readEntry(f.key);assert.equal(saved.state,'active');assert.equal(saved.bootstrap.state,'claimed');
    assert.equal(saved.bootstrap.runnerId,4);assert.equal(saved.token,f.entry.token);
    assert.deepEqual(JSON.parse((await job(f.key).get()).data().bootstrap),saved.bootstrap);
    assert.equal(JSON.stringify(await snapshot()).includes(f.material.encodedJitConfig),false);
    t.diagnostic(JSON.stringify({mode,mintCalls:calls,release:false,chargedEntries:1}));
  }
});
test('ambiguous mocked build submission retains its reservation and duplicates never resubmit',async t=>{
  const e=event(140);let calls=0;
  const provisioning=control(async()=>{calls++;throw Object.assign(Error('synthetic response lost'),{code:4});});
  await assert.rejects(provisioning.provision(e),/synthetic response lost/);
  const before=await snapshot(),saved=await readEntry(identity(e).key);
  assert.equal(saved.state,'submitting');assert.equal(saved.creationStarted,false);
  assert.equal(await provisioning.provision(e),'submitting');assert.equal(calls,1);
  assert.deepEqual(await snapshot(),before);
  t.diagnostic(JSON.stringify({mockBuildCalls:calls,chargedEntries:1,state:'submitting'}));
});
