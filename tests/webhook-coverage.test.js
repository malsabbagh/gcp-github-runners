'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {createWebhookRuntime}=require('../cloud-functions/webhook-handler/webhook-runtime');
const {coordinator,identity,readPool}=require('../cloud-functions/webhook-handler/provisioning-state');

function store(initial={}) {
  const data=structuredClone(initial),options={};
  const snapshot=key=>({exists:Object.hasOwn(data,key),data:()=>structuredClone(data[key])});
  const ref=key=>({key,async get(){if(options.failRead)throw Error('fixture-provider-detail');return snapshot(key);},
    async set(value){if(options.failWrite)throw Error('fixture-provider-detail');data[key]=structuredClone(value);}});
  return {data,options,firestore:{collection:name=>({doc:id=>ref(name+'/'+id)}),
    async runTransaction(callback){
      const writes=[];let writing=false;
      const answer=await callback({get:async r=>{assert.equal(writing,false);if(options.failTransaction)throw Error('fixture-provider-detail');return snapshot(r.key);},
        set:(r,value,opts)=>{writing=true;writes.push([r.key,structuredClone(value),opts]);},
        update:(r,value)=>{writing=true;writes.push([r.key,structuredClone(value),{merge:true}]);}});
      for(const [key,value,opts]of writes)data[key]=opts?.merge?{...data[key],...value}:value;
      return answer;
    }}};
}
const queued={action:'queued',verifiedWebhook:true,repo_owner:'example',repo_name:'repository',run_id:'100',job_id:'200',run_attempt:'1',labels:['self-hosted','gcp-one-job']};
const env=()=>({GOOGLE_CLOUD_PROJECT:'example-project',DEFAULT_ZONE:'us-central1-a',INSTANCE_TEMPLATE_NAME:'fixture-template',MAX_RUNNER_VMS:'2',
  FIRESTORE_DATABASE_ID:'runner-state',VM_CREATION_TIMEOUT_SECONDS:'600',GITHUB_WEBHOOK_SECRET_VERSION:'projects/example-project/secrets/fixture-hook/versions/1',
  BUILDER_IMAGE:'registry.example.invalid/builder@sha256:'+'a'.repeat(64),WORKER_SERVICE_ACCOUNT:'worker@example-project.iam.gserviceaccount.com',WORKER_SERVICE_ACCOUNT_UNIQUE_ID:'123456',
  ALLOCATION_BROKER_URL:'https://controller.example.invalid/bootstrap',GITHUB_REPO_OWNER:'example',GITHUB_REPO_NAME:'repository',CLOUDBUILD_SERVICE_ACCOUNT:'builder@example-project.iam.gserviceaccount.com',
  RUNNER_ROUTING_LABEL:'gcp-one-job',RUNNER_LABELS_JSON:JSON.stringify(['self-hosted','linux','x64','gcp-one-job']),REQUIRED_RUNNER_LABELS:JSON.stringify(['self-hosted','gcp-one-job'])});
function webhookFixture({environment=env(),initial={},scopes=[]}={}) {
  const db=store(initial),calls={builds:[],reads:0},options={hmac:'fixture-only-hmac'};
  const cloudBuild={async createBuild(input){calls.builds.push(input);if(options.buildError)throw options.buildError;return [{metadata:{build:{id:'fixture-build'}}}];},
    async listBuilds(){return [[]];},async getBuild(){return [{status:'WORKING'}];}};
  const compute={async *aggregatedListAsync(){for(const scope of scopes)yield scope;},async get(){throw Object.assign(Error('fixture-provider-detail'),{code:5});}};
  const secretManager={async accessSecretVersion(){calls.reads++;if(options.secretError)throw Error('fixture-provider-detail');return [{payload:{data:Buffer.from(options.hmac)}}];}};
  const runtime=createWebhookRuntime({environment,clients:{cloudBuild,compute,secretManager,firestore:db.firestore}});
  async function request({body,raw,headers={},method='POST',delivery='fixture-delivery',event='workflow_job'}={}) {
    const payload=body===undefined?{action:'queued',repository:{owner:{login:'example'},name:'repository',id:1},workflow_job:{id:200,run_id:100,run_attempt:1,labels:['self-hosted','gcp-one-job']}}:body;
    const bytes=raw===undefined?Buffer.from(JSON.stringify(payload)):raw;
    const signature=Buffer.isBuffer(bytes)?'sha256='+crypto.createHmac('sha256',options.hmac).update(bytes).digest('hex'):undefined;
    const req={method,rawBody:bytes,body:payload,headers:{'x-hub-signature-256':signature,'x-github-event':event,'x-github-delivery':delivery,...headers}};
    const res={statusCode:0,body:null,status(code){this.statusCode=code;return this;},send(body){this.body=body;return this;}};
    await runtime.webhookHandler(req,res);return res;
  }
  return {db,calls,options,runtime,request,environment};
}
function provisionFixture({initial={},scopes=[],createBuild,overrides={}}={}) {
  const db=store(initial),calls=[];
  const cfg={firestore:db.firestore,cloudBuild:{},compute:{async *aggregatedListAsync(){for(const scope of scopes)yield scope;}},
    project:'example-project',zone:'us-central1-a',limit:2,workerServiceAccountEmail:'worker@example-project.iam.gserviceaccount.com',workerServiceAccountUniqueId:'123456',
    brokerUrl:'https://controller.example.invalid/bootstrap',clock:()=>100000,createBuild:async(...args)=>{calls.push(args);return createBuild?createBuild(db,...args):{metadata:{build:{id:'fixture-build'}}};},...overrides};
  return {db,calls,controller:coordinator(cfg)};
}

test('public webhook rejects transport/signature/JSON errors before any reservation and hides provider details',async t=>{
  t.mock.method(console,'error',()=>{});
  const f=webhookFixture();
  for(const [input,code]of [[{method:'GET'},405],[{raw:'not-a-buffer'},400],[{raw:Buffer.alloc(262145)},413],
    [{delivery:null},400],[{headers:{'x-hub-signature-256':'sha1=invalid'}},401],[{raw:Buffer.from('{')},400]]){
    const res=await f.request(input);assert.equal(res.statusCode,code);assert.equal(f.calls.builds.length,0);
  }
  f.options.secretError=true;const res=await f.request();assert.equal(res.statusCode,500);assert.equal(res.body.includes('fixture-provider-detail'),false);
  for(const value of ['', '   ', 'placeholder-fixture']){f.options.secretError=false;f.options.hmac=value;assert.equal((await f.request()).statusCode,500);}
  assert.equal(f.calls.builds.length,0);assert.equal(Object.keys(f.db.data).length,0);
});
test('public runtime accepts only canonical dedicated labels and repository while preserving one-job build contract',async t=>{
  t.mock.method(console,'log',()=>{});t.mock.method(console,'error',()=>{});
  const f=webhookFixture();
  for(const change of [{repository:{owner:{login:'other'},name:'repository'}},{repository:{owner:{login:'example'},name:'other'}},
    {workflow_job:{id:200,run_id:100,labels:['self-hosted','unregistered']}},{workflow_job:{id:200,run_id:100,labels:['gcp-one-job']}},
    {workflow_job:{id:200,run_id:100,labels:['self-hosted']}}]){
    assert.equal((await f.request({body:{action:'queued',repository:{owner:{login:'example'},name:'repository'},workflow_job:{id:200,run_id:100},...change}})).statusCode,200);
  }
  assert.equal(f.calls.builds.length,0);
  f.environment.REQUIRED_RUNNER_LABELS_B64=Buffer.from(f.environment.REQUIRED_RUNNER_LABELS).toString('base64');
  const res=await f.request();assert.equal(res.statusCode,202);assert.equal(f.calls.builds.length,1);
  const build=f.calls.builds[0].build;assert.equal(build.serviceAccount,'projects/example-project/serviceAccounts/builder@example-project.iam.gserviceaccount.com');
  assert.equal(build.steps.length,1);assert.ok(build.steps[0].env.includes('WORKER_SERVICE_ACCOUNT=worker@example-project.iam.gserviceaccount.com'));
  assert.equal(build.steps[0].env.some(value=>/^RUNNERS_PER_VM=/.test(value)),false);
  assert.equal((await f.request({body:{action:'in_progress',repository:{owner:{login:'example'},name:'repository'},workflow_job:{id:200,run_id:100,labels:['self-hosted','gcp-one-job']}}})).statusCode,200);
});
test('completed and cancelled authenticated jobs tombstone demand without freeing unknown VM capacity',async t=>{
  t.mock.method(console,'error',()=>{});
  for(const action of ['completed','cancelled']){
    const f=webhookFixture();await f.request();
    const before=JSON.parse(f.db.data['provisioning_pools/global'].entries);
    const res=await f.request({body:{action,repository:{owner:{login:'example'},name:'repository'},workflow_job:{id:200,run_id:100,labels:['self-hosted','gcp-one-job']}}});
    assert.equal(res.statusCode,200);assert.match(res.body,/Completion/);
    assert.deepEqual(Object.keys(JSON.parse(f.db.data['provisioning_pools/global'].entries)),Object.keys(before));
    assert.equal((await f.request()).statusCode,200);assert.equal(f.calls.builds.length,1);
  }
});
test('workflow_run idempotency and event errors never expose state-store details',async t=>{
  t.mock.method(console,'log',()=>{});t.mock.method(console,'error',()=>{});
  const f=webhookFixture();const body={action:'completed',repository:{owner:{login:'example'},name:'repository'},workflow_run:{id:100,conclusion:'success'}};
  assert.equal((await f.request({body,event:'workflow_run'})).body,'cleanup triggered');
  assert.equal((await f.request({body,event:'workflow_run'})).body,'Event already processed');
  assert.equal((await f.request({body:{...body,action:undefined},event:'workflow_run',delivery:'other'})).body,'Event received but no action required');
  assert.equal((await f.request({body,event:'ping'})).body,'Event received but no action required');
  f.db.options.failRead=true;assert.equal((await f.request({body,event:'workflow_run'})).statusCode,500);
  f.db.options.failRead=false;f.db.options.failWrite=true;
  const res=await f.request({body,event:'workflow_run',delivery:'new'});assert.equal(res.statusCode,500);assert.equal(res.body.includes('fixture-provider-detail'),false);
});
test('public factory refuses label/configuration drift instead of building workers under stale defaults',()=>{
  for(const changes of [{RUNNER_LABELS_JSON:'null'},{RUNNER_LABELS_JSON:JSON.stringify(['self-hosted'])}])assert.throws(()=>webhookFixture({environment:{...env(),...changes}}));
  const f=webhookFixture();
  assert.equal(f.runtime.eligible({...queued,repo_owner:'EXAMPLE',repo_name:'REPOSITORY'}),true);
  assert.equal(f.runtime.eligible({...queued,labels:null}),false);
  for(const change of [{REQUIRED_RUNNER_LABELS:'null'},{REQUIRED_RUNNER_LABELS:JSON.stringify(['self-hosted','unregistered'])},
    {REQUIRED_RUNNER_LABELS:JSON.stringify(['gcp-one-job'])},{REQUIRED_RUNNER_LABELS:JSON.stringify(['self-hosted'])}]){
    const fixture=webhookFixture();Object.assign(fixture.environment,change);assert.throws(()=>fixture.runtime.eligible(queued));
  }
  for(const name of ['GITHUB_REPO_OWNER','GITHUB_REPO_NAME','CLOUDBUILD_SERVICE_ACCOUNT']){const fixture=webhookFixture();delete fixture.environment[name];assert.throws(()=>fixture.runtime.eligible(queued));}
});

test('capacity admission rejects incomplete inventory and corrupt state while keeping healthy empty-zone warnings usable',async()=>{
  for(const scopes of [[['regions/us-central1',{instances:[{name:'worker'}]}]],[['zones/us-central1-a',{warning:{code:'UNREACHABLE'}}]]]){
    const f=provisionFixture({scopes});await assert.rejects(f.controller.provision(queued));assert.equal(f.calls.length,0);
  }
  for(const value of [null,[],1])assert.throws(()=>readPool({exists:true,data:()=>({entries:JSON.stringify(value)})}));
  const healthy=provisionFixture({scopes:[['zones/us-central1-a',{warning:{code:'NO_RESULTS_ON_PAGE'}}]]});
  assert.equal(await healthy.controller.provision(queued),'pending');assert.equal(healthy.calls.length,1);
  const key=identity(queued).key,blocked=provisionFixture({initial:{['job_provisioning/'+key]:{bootstrap:'{"state":"issued"}'}}});
  await assert.rejects(blocked.controller.provision(queued),/Unarchived bootstrap/);assert.equal(blocked.calls.length,0);
});
test('invalid reservation clocks identity and TTL never submit a build',async()=>{
  for(const overrides of [{clock:()=>NaN},{bootstrapTTLms:0},{bootstrapTTLms:900001},{bootstrapTTLms:1.5},
    {workerServiceAccountEmail:null},{workerServiceAccountUniqueId:null},{brokerUrl:null}]){
    const f=provisionFixture({overrides});await assert.rejects(f.controller.provision(queued),/Invalid reservation profile/);assert.equal(f.calls.length,0);
  }
});
test('definitive build rejection archives prior bootstrap evidence before releasing only the matching reservation',async()=>{
  const key=identity(queued).key;
  for(const complete of [false,true]){
    const f=provisionFixture({createBuild:async db=>{
      db.data['job_provisioning/'+key]={...db.data['job_provisioning/'+key],done:complete,bootstrap:'{"state":"fixture-issued"}'};
      throw Object.assign(Error('fixture-refusal'),{code:7});
    }});
    await assert.rejects(f.controller.provision(queued),/fixture-refusal/);
    const demand=f.db.data['job_provisioning/'+key];assert.equal(demand.state,complete?'completed':'waiting');
    assert.equal(demand.bootstrap,undefined);assert.equal(JSON.parse(demand.bootstrapHistory).length,1);
    assert.equal(JSON.parse(demand.pendingCleanup).length,1);assert.deepEqual(JSON.parse(f.db.data['provisioning_pools/global'].entries),{});
  }
});
test('changed reservation after provider acceptance or refusal remains charged and is never overwritten',async()=>{
  const key=identity(queued).key;
  for(const reject of [false,true]){
    const f=provisionFixture({createBuild:async db=>{
      const pool=JSON.parse(db.data['provisioning_pools/global'].entries);pool[key].token='changed-reservation';db.data['provisioning_pools/global'].entries=JSON.stringify(pool);
      if(reject)throw Object.assign(Error('fixture-refusal'),{code:7});return{metadata:{build:{id:'fixture-build'}}};
    }});
    await assert.rejects(f.controller.provision(queued));assert.equal(JSON.parse(f.db.data['provisioning_pools/global'].entries)[key].token,'changed-reservation');
  }
  const accepted=provisionFixture({createBuild:async db=>{const pool=JSON.parse(db.data['provisioning_pools/global'].entries);pool[key].state='active';db.data['provisioning_pools/global'].entries=JSON.stringify(pool);return{metadata:{build:{id:'fixture-build'}}};}});
  assert.equal(await accepted.controller.provision(queued),'pending');assert.equal(JSON.parse(accepted.db.data['provisioning_pools/global'].entries)[key].state,'active');
});
test('completion proof is issued only for the authenticated exact registered runner',async()=>{
  const key=identity(queued).key;
  for(const changes of [{verifiedWebhook:false},{runner_id:11},{runner_name:'other'},{}]){
    const initial={'provisioning_pools/global':{entries:JSON.stringify({[key]:{name:'fixture-worker',zone:'us-central1-a',token:'fixture',state:'active',runnerIdentity:{id:10,name:'fixture-worker'}}})}};
    const f=provisionFixture({initial});await f.controller.complete({...queued,action:'completed',runner_id:10,runner_name:'fixture-worker',...changes});
    const demand=f.db.data['job_provisioning/'+key];assert.equal(Boolean(demand.completion),Object.keys(changes).length===0);assert.equal(demand.done,true);
    assert.equal(JSON.parse(f.db.data['provisioning_pools/global'].entries)[key].demandDone,true);
  }
});
