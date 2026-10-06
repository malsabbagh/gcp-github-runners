'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createWaitingRecovery} = require('../cloud-functions/webhook-handler/waiting-recovery');
const {createScheduledRecovery} = require('../cloud-functions/webhook-handler/scheduled-recovery');
const {coordinator,identity} = require('../cloud-functions/webhook-handler/provisioning-state');
const event = job => ({action:'queued',verifiedWebhook:true,repo_owner:'example',repo_name:'repository',run_id:'100',job_id:String(job),run_attempt:'1',labels:['self-hosted','gcp-one-job']});
function database(initial = []) {
  const docs = new Map(initial);
  const ref = (collection,id) => ({key:collection+'/'+id});
  const snapshot = (key,value) => ({id:key.split('/').pop(),exists:value!==undefined,data:()=>structuredClone(value)});
  const collection = name => ({
    doc:id=>ref(name,id),
    where(field,operator,value) {
      assert.deepEqual([field,operator,value],['state','==','waiting']);
      const query = {collection:name,after:'',count:0,
        orderBy(field) {assert.equal(field,'__name__');return this;},
        limit(count) {this.count=count;return this;},
        startAfter(after) {return {...this,after};}};
      return query;
    }
  });
  const firestore = {collection,runTransaction:async body=>{
    const writes=[];let writing=false;
    const answer=await body({
      get:async target=>{
        assert.equal(writing,false,'Firestore reads must precede writes');
        if (target.collection) {
          const rows=[...docs].filter(([key,value])=>key.startsWith(target.collection+'/')&&value.state==='waiting'&&key.split('/').pop()>target.after)
            .sort(([a],[b])=>a.localeCompare(b)).slice(0,target.count);
          return {empty:rows.length===0,docs:rows.map(([key,value])=>snapshot(key,value))};
        }
        return snapshot(target.key,docs.get(target.key));
      },
      set:(target,value)=>{writing=true;writes.push([target.key,structuredClone(value)]);}
    });
    for (const [key,value] of writes) docs.set(key,value);
    return answer;
  }};
  return {docs,firestore};
}
function demands(count) {
  return Array.from({length:count},(_,index)=>event(index+1)).map(value=>['job_provisioning/'+identity(value).key,{done:false,state:'waiting',event:JSON.stringify(value)}]);
}
test('waiting demand without an active pool entry is replayed fairly in bounded pages',async()=>{
  const db=database(demands(5)),calls=[];
  const waiting=createWaitingRecovery({firestore:db.firestore,batchSize:2,isEligible:()=>true,provisioning:{provision:async e=>{calls.push(identity(e).key);return 'capacity';}}});
  for(let i=0;i<3;i++) assert.equal((await waiting.recoverWaiting()).status,'completed');
  assert.equal(calls.length,5);assert.equal(new Set(calls).size,5);
  await waiting.recoverWaiting();assert.equal(calls.length,7);assert.deepEqual(calls.slice(5),calls.slice(0,2));
});
test('malformed out-of-scope and completed demands never reach the coordinator',async()=>{
  const initial=demands(4),db=database(initial),calls=[];
  db.docs.get(initial[0][0]).event='{';
  db.docs.get(initial[1][0]).done=true;
  db.docs.get(initial[2][0]).executedBy='known-allocation';
  const waiting=createWaitingRecovery({firestore:db.firestore,isEligible:()=>false,provisioning:{provision:async e=>{calls.push(e);return 'pending';}}});
  assert.deepEqual(await waiting.recoverWaiting(),{status:'completed',processed:0,failures:2});assert.deepEqual(calls,[]);
});
test('provider failure preserves demand and does not starve later rows',async()=>{
  const db=database(demands(2)),before=structuredClone([...db.docs]),calls=[];
  const waiting=createWaitingRecovery({firestore:db.firestore,isEligible:()=>true,provisioning:{provision:async e=>{calls.push(e);if(calls.length===1)throw Error('private-provider-detail');return 'pending';}}});
  assert.deepEqual(await waiting.recoverWaiting(),{status:'completed',processed:1,failures:1});assert.equal(calls.length,2);
  for(const [key,value]of before)assert.deepEqual(db.docs.get(key),value);
});
test('missing eligibility qualification stays closed without state or provider calls',async()=>{
  const db=database(demands(1));let calls=0;
  const waiting=createWaitingRecovery({firestore:db.firestore,provisioning:{provision:async()=>calls++}});
  assert.deepEqual(await waiting.recoverWaiting(),{status:'disabled',processed:0,failures:0});assert.equal(calls,0);
  assert.equal(db.docs.has('provisioning_cursors/waiting-runtime'),false);
});
test('freed capacity triggers exactly one canonical build through authenticated scheduler',async()=>{
  const db=database();let full=true,builds=0;
  const compute={async *aggregatedListAsync(){yield ['zones/us-central1-a',{instances:full?[{name:'existing-worker'}]:[]}];}};
  const recovery={hydrateAllocation:async()=>({status:'preserved'}),recoverAbsentAllocation:async()=>({status:'preserved'})};
  const provisioning=coordinator({firestore:db.firestore,compute,recovery,project:'example-project',zone:'us-central1-a',limit:1,
    workerServiceAccountEmail:'worker@example-project.iam.gserviceaccount.com',workerServiceAccountUniqueId:'123456789',brokerUrl:'https://controller.example.invalid/bootstrap',
    createBuild:async()=>{builds++;return{metadata:{build:{id:'fixture-build'}}};}});
  const demand=event(100);assert.equal(await provisioning.provision(demand),'capacity');assert.equal(builds,0);
  assert.equal(db.docs.has('provisioning_pools/global'),false);
  const waitingRecovery=createWaitingRecovery({firestore:db.firestore,provisioning,isEligible:()=>true});
  const audience='https://controller.example.invalid';let authenticated=false;
  const scheduler=createScheduledRecovery({firestore:db.firestore,recovery,waitingRecovery,enabled:true,expectedAudience:audience,
    adminSubject:'admin-subject',schedulerSubject:'scheduler-subject',authenticateInvocation:async()=>authenticated?{verified:true,audience,subject:'scheduler-subject',role:'scheduler'}:null});
  full=false;
  assert.equal((await scheduler.runScheduled({})).status,'denied');assert.equal(builds,0);
  authenticated=true;
  assert.deepEqual(await scheduler.runScheduled({}),{status:'completed',processed:0,failures:0});assert.equal(builds,1);
  const key=identity(demand).key;assert.equal(db.docs.get('job_provisioning/'+key).state,'pending');
  assert.equal(JSON.parse(db.docs.get('provisioning_pools/global').entries)[key].buildId,'fixture-build');
  await scheduler.runScheduled({});assert.equal(builds,1);
});
