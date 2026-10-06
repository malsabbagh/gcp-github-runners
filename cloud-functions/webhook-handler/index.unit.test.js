'use strict';
const {createWebhookRuntime}=require('./webhook-runtime');
const {load}=require('../../tests/provisioning/harness.cjs');
const crypto=require('node:crypto');
afterEach(()=>jest.restoreAllMocks());
test('signatures bind exact bytes, algorithm and secret',()=> {
  const {verifySignature}=load().handler,body=Buffer.from('{"ok":true}'),secret='offline-'+'secret';
  const good='sha256='+crypto.createHmac('sha256',secret).update(body).digest('hex');
  expect(verifySignature(body,good,secret)).toBe(true);
  for(const [bytes,sig,key] of [[Buffer.concat([body,Buffer.from(' ')]),good,secret],[body,good,'other'],[body,null,secret],[body,'sha256=short',secret],[body,good,null],[body,'sha1='+good.slice(7),secret]]) expect(verifySignature(bytes,sig,key)).toBe(false);
});
test('event recording retains idempotency and serializable undefined fields',async()=> {
  const t=load();expect(await t.handler.isEventProcessed('one')).toBe(false);
  await t.handler.markEventProcessed('one',{nested:{defined:'value',absent:undefined}});
  expect(await t.handler.isEventProcessed('one')).toBe(true);
  expect(t.store.get('processed_events/one').event_data).toEqual({nested:{defined:'value',absent:null}});
});
test('store and secret failures stay retryable; no false successful evidence',async()=> {
  jest.spyOn(console,'error').mockImplementation(()=>{});const t=load({failStore:true});
  await expect(t.handler.isEventProcessed('one')).rejects.toThrow('store unavailable');
  const u=load();u.handler.clients.firestore.collection=()=>({doc:()=>({set:async()=>{throw Error('unavailable');}})});
  await expect(u.handler.markEventProcessed('one',{})).rejects.toThrow('unavailable');
});
test('build request keeps provisioning script and distinct identities and refuses unreserved creation',async()=> {
  const t=load();await expect(t.handler.createVMInstance('example','repo')).rejects.toThrow('Durable reservation');
  await t.request();const build=t.calls.builds[0].build;
  expect(build.serviceAccount).toBe('projects/example-project/serviceAccounts/provisioner@example-project.iam.gserviceaccount.com');
  expect(build.steps[0].args[1]).toContain('RUNNER_PROVISIONER');
  expect(build.steps[0].env).toContain('WORKER_SERVICE_ACCOUNT=worker@example-project.iam.gserviceaccount.com');
  expect(build.steps[0].env.some(v=>/PAT|PRIVATE_KEY/.test(v))).toBe(false);
});
test('unrecognized workflow actions and run completion do not provision or change allocation ownership',async()=> {
  jest.spyOn(console,'log').mockImplementation(()=>{});const t=load();
  expect(await t.handler.processWorkflowJobEvent({action:'unknown'})).toBe('completed');
  await t.handler.processWorkflowRunEvent({action:'completed'});await t.handler.processWorkflowRunEvent({action:'requested'});
  expect(t.calls.builds).toHaveLength(0);expect(t.pool()).toEqual({});
});
test('runtime factory rejects private environment fallbacks and malformed routing labels',()=> {
  expect(()=>createWebhookRuntime({environment:{}})).toThrow('Invalid GOOGLE_CLOUD_PROJECT');
  expect(()=>load({env:{RUNNER_LABELS_JSON:'[]'}})).toThrow('Dedicated registered runner labels');
});
