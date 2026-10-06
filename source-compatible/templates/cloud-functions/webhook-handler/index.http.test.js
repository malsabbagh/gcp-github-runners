const {load} = require('../../tests/provisioning/harness.cjs');
const originalEnv = {...process.env};
function subject(options={}) {
  return load(options, ({env,factories}) => {
    jest.resetModules();
    process.env = {...originalEnv, ...env};
    for(const name of ['GITHUB_WEBHOOK_SECRET','GITHUB_WEBHOOK_SECRET_NAME','SKIP_SIGNATURE_VERIFICATION','REQUIRED_RUNNER_LABELS','REQUIRED_RUNNER_LABELS_B64']) if(!(name in env)) delete process.env[name];
    Object.entries(factories).forEach(([name,value])=>jest.doMock(name,()=>value));
    return require('./index');
  });
}
beforeEach(()=>{jest.spyOn(console,'log').mockImplementation(()=>{});jest.spyOn(console,'error').mockImplementation(()=>{});jest.spyOn(console,'warn').mockImplementation(()=>{});});
afterEach(()=>{process.env=originalEnv;jest.restoreAllMocks();});

test('fresh sync environment rejects unsigned requests and accepts default-secret HMAC over exact bytes',async()=>{
  const t=subject();
  expect((await t.request({signature:null})).statusCode).toBe(401);
  expect(t.calls.builds).toHaveLength(0);
  expect(t.calls.secrets[0]).toContain('github-webhook-secret');
  expect((await t.request({raw:false})).statusCode).toBe(400);
  expect((await t.request({bodyOverride:{action:'completed'}})).statusCode).toBe(202);
  expect(t.calls.builds).toHaveLength(1);
});
test.each([{secret:''},{secret:'placeholder-synthetic'},{env:{SKIP_SIGNATURE_VERIFICATION:'true'}},{failSecret:true}])('unsafe or inaccessible secret configuration fails closed: %j',async(options)=>{
  const t=subject(options);
  expect([401,500]).toContain((await t.request({signature:'sha256='+'a'.repeat(64)})).statusCode);
  expect(t.calls.builds).toHaveLength(0);
});
test('direct configured secret also requires a matching HMAC',async()=>{
  const t=subject({secret:'direct-synthetic',env:{GITHUB_WEBHOOK_SECRET:'direct-synthetic'}});
  expect((await t.request()).statusCode).toBe(202);
  expect(t.calls.secrets).toHaveLength(0);
});
test.each([{labels:['ubuntu-latest']},{labels:['ubicloud-standard-2']},{owner:'other'},{repo:'other'}])('unrelated job does not reserve or submit: %j',async(event)=>{
  const t=subject(); expect((await t.request(event)).statusCode).toBe(200);expect(t.calls.builds).toHaveLength(0);expect(t.pool()).toEqual({});
});
test('configured labels survive delimiter-safe sync environment',async()=>{
  const t=subject({env:{REQUIRED_RUNNER_LABELS_B64:Buffer.from(JSON.stringify(['self-hosted','multi-user'])).toString('base64')}});
  expect((await t.request()).statusCode).toBe(200); expect(t.calls.builds).toHaveLength(0);
  expect((await t.request({labels:['self-hosted','multi-user']})).statusCode).toBe(202);
});
test('definitive rejection retries identical delivery and later duplicates retain pending build',async()=>{
  const t=subject({failSubmission:8});expect((await t.request()).statusCode).toBe(500);
  t.options.failSubmission=false;expect((await t.request()).statusCode).toBe(202);expect((await t.request()).statusCode).toBe(202);expect(t.calls.builds).toHaveLength(2);
});
test.each([{failSubmission:6},{failSubmission:13},{failSubmission:14},{missingBuildId:true}])('ambiguous acceptance stays charged and never resubmits: %j',async(options)=>{
  const t=subject(options);expect((await t.request()).statusCode).toBe(500);expect((await t.request({delivery:'other'})).statusCode).toBe(503);expect(t.calls.builds).toHaveLength(1);
});
test('terminal asynchronous failure retries only after absent VM proof',async()=>{
  const t=subject();await t.request();t.builds.get('build-1').status='FAILURE';expect((await t.request()).statusCode).toBe(202);expect(t.calls.builds).toHaveLength(2);
  const u=subject();await u.request();u.builds.get('build-1').status='FAILURE';u.live.add(Object.values(u.pool())[0].name);expect((await u.request()).statusCode).toBe(200);expect(u.calls.builds).toHaveLength(1);
});
test('success without observable VM remains uncertain rather than reinserted',async()=>{
  const t=subject();await t.request();t.builds.get('build-1').status='SUCCESS';expect((await t.request()).statusCode).toBe(503);expect(t.calls.builds).toHaveLength(1);
});
test.each(['token','state'])('stale reconciliation cannot overwrite changed reservation %s',async(field)=>{
  const t=subject();await t.request();t.builds.get('build-1').status='FAILURE';
  const readBuild=t.builds.get.bind(t.builds);
  let replacement;
  t.builds.get=id=>{
    const pool=t.pool();const key=Object.keys(pool)[0];
    pool[key]={...pool[key],[field]:field==='token'?'new-owner-token':'active'};
    replacement=pool[key];
    t.store.set('provisioning_pools/global',{entries:JSON.stringify(pool)});
    return readBuild(id);
  };
  expect((await t.request()).statusCode).toBe(field==='token'?202:200);
  expect(Object.values(t.pool())).toEqual([replacement]);
  expect(t.calls.builds).toHaveLength(1);
});
test('12 concurrent jobs reserve at most 2 pending VMs and store excess demand separately',async()=>{
  const t=subject();const results=await Promise.all(Array.from({length:12},(_,i)=>t.request({job:i+1,delivery:'d'+i})));
  expect(t.calls.builds).toHaveLength(2);expect(results.filter(r=>r.statusCode===202)).toHaveLength(2);expect(t.jobs().filter(j=>j.state==='waiting')).toHaveLength(10);expect(Object.keys(t.pool())).toHaveLength(2);
});
test.each([{live:['one','two']},{failInventory:true},{failStore:true},{failBuildRead:true}])('uncertain state and existing capacity prevent new creates: %j',async(options)=>{
  const t=subject(options);if(options.failBuildRead){await t.request();expect((await t.request()).statusCode).toBe(500);expect(t.calls.builds).toHaveLength(1);}else{expect([500,503]).toContain((await t.request()).statusCode);expect(t.calls.builds).toHaveLength(0);}
});
test('completion/cancellation durable tombstones prevent late queue events',async()=>{
  for(const action of ['completed','cancelled']) {const t=subject();expect((await t.request({action})).statusCode).toBe(200);expect((await t.request()).statusCode).toBe(200);expect(t.calls.builds).toHaveLength(0);expect(t.pool()).toEqual({});}
});
test('completed absent VM is compacted from capacity pool without losing deduplication',async()=>{
  const t=subject();await t.request();const allocation=Object.values(t.pool())[0];t.live.add(allocation.name);t.builds.get('build-1').status='SUCCESS';await t.request();await t.request({action:'completed'});t.live.clear();await t.request();expect(t.pool()).toEqual({});expect(t.calls.builds).toHaveLength(1);
});
test('Spot loss before completion recovers original demand',async()=>{
  const t=subject();await t.request();const allocation=Object.values(t.pool())[0];t.live.add(allocation.name);t.builds.get('build-1').status='SUCCESS';await t.request();t.live.clear();expect((await t.request()).statusCode).toBe(202);expect(t.calls.builds).toHaveLength(2);
});
test('method and malformed identity cannot create infrastructure',async()=>{
  const t=subject();const res={status:jest.fn().mockReturnThis(),send:jest.fn().mockReturnThis()};await t.handler.webhookHandler({method:'GET'},res);expect(res.status).toHaveBeenCalledWith(405);
  expect((await t.request({job:'1;anything'})).statusCode).toBe(500);expect(t.calls.builds).toHaveLength(0);
});
async function signed(handler, body, event='ping', extraHeaders={}) {
  const bytes=Buffer.from(typeof body==='string'?body:JSON.stringify(body));
  const signature='sha256='+require('crypto').createHmac('sha256','synthetic-webhook-secret').update(bytes).digest('hex');
  const res={statusCode:0,body:'',status(n){this.statusCode=n;return this;},send(body){this.body=body;return this;}};
  await handler.webhookHandler({method:'POST',headers:{'x-github-event':event,'x-hub-signature-256':signature,...extraHeaders},rawBody:bytes,body:{}},res);
  return res;
}
test('ping, unknown and manual events acknowledge without creating infrastructure',async()=>{
  const t=subject();
  for(const [event,body] of [['ping',{}],['unknown',{}],['repository',{action:'create_runner'}]]) expect((await signed(t.handler,body,event)).statusCode).toBe(200);
  expect(t.calls.builds).toHaveLength(0);
});
test('signed malformed JSON and workflow_job without delivery are rejected before state writes',async()=>{
  const t=subject();expect((await signed(t.handler,'{','ping')).statusCode).toBe(400);expect((await signed(t.handler,{},'workflow_job')).statusCode).toBe(400);expect(t.store.size).toBe(0);
});
test('missing event header acknowledges without state or infrastructure changes',async()=>{
  const t=subject();expect((await signed(t.handler,{},'ping',{'x-github-event':undefined})).statusCode).toBe(200);
  expect(t.calls.builds).toHaveLength(0);expect(t.store.size).toBe(0);
});
test('wrong-length signature rejects before malformed JSON is parsed',async()=>{
  const t=subject();expect((await signed(t.handler,'{','ping',{'x-hub-signature-256':'sha256=abc'})).statusCode).toBe(401);
  expect(t.calls.builds).toHaveLength(0);expect(t.store.size).toBe(0);
});
test('workflow run completion deduplicates only after processing; missing action is ignored',async()=>{
  const t=subject();const body={action:'completed',repository:{id:1,owner:{login:'example'},name:'repo'},workflow_run:{id:20,conclusion:'success'}};
  expect((await signed(t.handler,body,'workflow_run',{'x-github-delivery':'run-completion'})).statusCode).toBe(200);
  expect((await signed(t.handler,body,'workflow_run',{'x-github-delivery':'run-completion'})).body).toBe('Event already processed');
  expect((await signed(t.handler,{repository:body.repository,workflow_run:{id:21}},'workflow_run',{'x-github-delivery':'run-missing-action'})).statusCode).toBe(200);
  expect(t.calls.builds).toHaveLength(0);
});
test('workflow run state read failure remains retryable rather than success',async()=>{
  const t=subject({failStore:true});const body={action:'completed',repository:{id:1,owner:{login:'example'},name:'repo'},workflow_run:{id:20}};
  expect((await signed(t.handler,body,'workflow_run',{'x-github-delivery':'failed-run-read'})).statusCode).toBe(500);
});
test('missing managed repository or invalid required labels fails closed',async()=>{
  for(const env of [{GITHUB_REPO_OWNER:''},{REQUIRED_RUNNER_LABELS:'["windows"]'},{REQUIRED_RUNNER_LABELS:'{'}]) {const t=subject({env});expect((await t.request()).statusCode).toBe(500);expect(t.calls.builds).toHaveLength(0);}
});
