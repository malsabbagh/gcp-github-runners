const {test} = require('node:test');
const assert = require('node:assert/strict');
const {load} = require('./harness.cjs');
const {identity} = require('../../cloud-functions/webhook-handler/provisioning-state');

test('fresh deployment requires default Secret Manager HMAC and exact raw body', async () => {
  const t = load();
  assert.equal((await t.request({signature: null})).statusCode,401);
  assert.equal(t.calls.builds.length,0);
  assert.match(t.calls.secrets[0],/github-webhook-secret/);
  assert.equal((await t.request({raw:false})).statusCode,400);
  assert.equal((await t.request({bodyOverride:{action:'completed'}})).statusCode,202);
  assert.equal(t.calls.builds.length,1);
});
test('empty secrets, bypass env, malformed signatures, and secret-read errors fail closed', async () => {
  for (const options of [{secret:''},{env:{SKIP_SIGNATURE_VERIFICATION:'true'}},{failSecret:true}]) {
    const t = load(options);
    const res = await t.request({signature:'sha256='+'a'.repeat(64)});
    assert.ok([401,500].includes(res.statusCode));
    assert.equal(t.calls.builds.length,0);
  }
});
test('hosted, Ubicloud, and other repositories produce zero reservations', async () => {
  const t=load();
  for(const event of [{labels:['ubuntu-latest']},{labels:['ubicloud-standard-2']},{owner:'other'},{repo:'other'}]) assert.equal((await t.request(event)).statusCode,200);
  assert.equal(t.calls.builds.length,0);
  assert.deepEqual(t.pool(),{});
});
test('definitive rejected submission retries identical delivery; later duplicates share pending allocation', async () => {
  const t=load({failSubmission:8});
  assert.equal((await t.request()).statusCode,500);
  t.options.failSubmission=false;
  assert.equal((await t.request()).statusCode,202);
  assert.equal((await t.request()).statusCode,202);
  assert.equal(t.calls.builds.length,2);
});
test('unknown acceptance never drops reservation or resubmits', async () => {
  for(const options of [{failSubmission:14},{missingBuildId:true}]) {
    const t=load(options);
    assert.equal((await t.request()).statusCode,500);
    assert.equal((await t.request({delivery:'another'})).statusCode,503);
    assert.equal(t.calls.builds.length,1);
  }
});
test('asynchronous failure releases only absent VM and permits recovery', async () => {
  const t=load(); await t.request(); t.builds.get('build-1').status='FAILURE';
  assert.equal((await t.request()).statusCode,202);
  assert.equal(t.calls.builds.length,2);
  const u=load(); await u.request(); u.builds.get('build-1').status='FAILURE'; u.live.add(Object.values(u.pool())[0].name);
  assert.equal((await u.request()).statusCode,200); assert.equal(u.calls.builds.length,1);
});
test('concurrent jobs reserve pending VMs in VM units and persist excess demand', async () => {
  const t=load();
  const results=await Promise.all(Array.from({length:12},(_,i)=>t.request({job:i+1,delivery:'delivery-'+i})));
  assert.equal(t.calls.builds.length,2);
  assert.equal(results.filter(r=>r.statusCode===202).length,2);
  assert.equal(results.filter(r=>r.statusCode===503).length,10);
  assert.equal(t.jobs().filter(e=>e.state==='waiting').length,10);
  assert.notEqual(Object.values(t.pool())[0].name,Object.values(t.pool())[1].name);
});
test('existing VM inventory, uncertain inventory, and state-store failures enforce cap', async () => {
  for(const options of [{live:['existing-1','existing-2']},{failInventory:true},{failStore:true}]) {
    const t=load(options); assert.ok([500,503].includes((await t.request()).statusCode)); assert.equal(t.calls.builds.length,0);
  }
});
test('completion tombstone prevents delayed queued event creating a VM',async()=>{
  const t=load(); assert.equal((await t.request({action:'completed'})).statusCode,200);
  assert.equal((await t.request()).statusCode,200); assert.equal(t.calls.builds.length,0);
});
test('full numeric job identity and normalization collisions retain valid bounded names',()=>{
  const base={repo_owner:'a'.repeat(39),repo_name:'b'.repeat(100),run_id:'9007199254740993',job_id:'9007199254740995',run_attempt:'1'};
  const a=identity(base),b=identity({...base,job_id:'9007199254740996'}),c=identity({...base,run_attempt:'2'});
  assert.match(a.name,/^[a-z][a-z0-9-]{0,61}[a-z0-9]$/); assert.ok(a.name.length<=63); assert.notEqual(a.name,b.name);assert.notEqual(a.name,c.name);
  assert.throws(()=>identity({...base,job_id:'1;touch'}));
  const t=load(); assert.notEqual(t.handler.generateBranchVMId('owner','repo','a/b'),t.handler.generateBranchVMId('owner','repo','a-b'));
  assert.ok(t.handler.generateBranchVMId('a'.repeat(39),'b'.repeat(100),null).length<=63);
});
