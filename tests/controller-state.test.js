'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { coordinator, identity } = require('../cloud-functions/webhook-handler/provisioning-state');
const { createBootstrapRuntime } = require('../cloud-functions/webhook-handler/bootstrap-runtime');

function fixture({ records = {}, recovery, failTransaction = 0, createBuild,
  batchSize = 2, limit = 1 } = {}) {
  const db = structuredClone(records); let transactions = 0, builds = 0;
  const ref = path => ({path, async get() {
    return {exists: Object.hasOwn(db, path), data: () => structuredClone(db[path])};
  }});
  const firestore = {collection: collection => ({doc: key => ref(`${collection}/${key}`)}),
    async runTransaction(callback) {
      transactions++;
      if (transactions === failTransaction) throw Object.assign(Error('synthetic_persistence_failure'), {code: 7});
      const writes = [];
      const result = await callback({get: r => r.get(), set: (r, data) => writes.push([r.path, structuredClone(data)])});
      for (const [path, data] of writes) db[path] = data;
      return result;
    }};
  const controller = coordinator({firestore, cloudBuild: {},
    compute: {async *aggregatedListAsync() {}}, recovery,
    project: 'example-project', zone: 'example-region1-a', limit,
    workerServiceAccountEmail: 'worker@example-project.iam.gserviceaccount.com',
    workerServiceAccountUniqueId: '123456', brokerUrl: 'https://broker.example.invalid',
    bootstrapTTLms: 600000, clock: () => 100000, recoveryBatchSize: batchSize,
    createBuild: async (...args) => {builds++; return createBuild ? createBuild(...args) :
      {metadata: {build: {id: 'fixture-build'}}};}});
  return {controller, db, builds: () => builds,
    entries: () => JSON.parse(db['provisioning_pools/global']?.entries || '{}')};
}
const event = {repo_owner: 'example', repo_name: 'fixture', run_id: '1', job_id: '2', run_attempt: '1'};

test('accepted submission persistence failure cannot be classified as build refusal or reminted', async () => {
  const f = fixture({failTransaction: 2}); const key = identity(event).key;
  await assert.rejects(f.controller.provision(event), error => error.code === 7);
  assert.equal(f.entries()[key].state, 'submitting');
  assert.equal(f.entries()[key].creationStarted, false);
  assert.equal(f.entries()[key].bootstrapExpiresAtMs, 700000);
  assert.equal(await f.controller.provision(event), 'submitting');
  assert.equal(f.builds(), 1);
});
test('accepted build without durable ID stays charged rather than claiming absence', async () => {
  const f = fixture({createBuild: async () => ({})});
  await assert.rejects(f.controller.provision(event), /durable build identity/);
  assert.equal(f.entries()[identity(event).key].state, 'submitting');
});
test('filtered empty inventory cannot release an existing allocation without exact recovery', async () => {
  const f = fixture({records: {'provisioning_pools/global': {entries: JSON.stringify({
    ['b'.repeat(64)]: {name: 'existing-worker', zone: 'example-region1-a', state: 'active', token: 'fixture'}
  })}}});
  assert.deepEqual(await f.controller.reconcile(), {status: 'preserved', reason: 'recovery_unwired'});
  assert.equal(await f.controller.provision(event), 'capacity');
  assert.equal(Object.keys(f.entries()).length, 1); assert.equal(f.builds(), 0);
});
test('delayed queued demand with durable actual dispatch creates no additional VM', async () => {
  const key = identity(event).key;
  const f = fixture({records: {['job_provisioning/' + key]: {done: false, executedBy: '{"state":"running"}'}}});
  assert.equal(await f.controller.provision(event), 'associated');
  assert.equal(f.builds(), 0); assert.equal(Object.keys(f.entries()).length, 0);
});
test('bounded recovery cursor rotates and one failed observation cannot starve other allocations', async () => {
  const seen = [], keys = ['a', 'b', 'c'].map(x => x.repeat(64));
  const f = fixture({records: {'provisioning_pools/global': {entries: JSON.stringify(
    Object.fromEntries(keys.map(key => [key, {}]))) }},
    recovery: {async hydrateAllocation(key) {seen.push(key); if (key === keys[0]) throw Error('synthetic_unknown');
      return {status: 'preserved', reason: 'fixture'};}}});
  const first = await f.controller.reconcile(); await f.controller.reconcile();
  assert.deepEqual(seen, [keys[0], keys[1], keys[2], keys[0]]);
  assert.equal(first.outcomes[0].status, 'preserved');
});
test('exact absence delegates to ownership-bound recovery rather than coordinator release', async () => {
  const calls = [];
  const f = fixture({records: {'provisioning_pools/global': {entries: JSON.stringify({['a'.repeat(64)]: {}})}},
    recovery: {async hydrateAllocation(key) {calls.push('inspect'); return {status: 'absent'};},
      async recoverAbsentAllocation(key) {calls.push('recover'); return {status: 'preserved', reason: 'unknown_insert'};}}});
  const result = await f.controller.reconcile(); assert.deepEqual(calls, ['inspect', 'recover']);
  assert.equal(result.outcomes[0].status, 'preserved'); assert.equal(Object.keys(f.entries()).length, 1);
});
test('unqualified JIT runtime denies before any SDK-facing initialization even with transport admitted', async () => {
  const runtime = createBootstrapRuntime({transportGuard: () => true});
  const res = {status(code) {this.code = code; return this;}, json(body) {this.body = body;}};
  await runtime.handle({}, res); assert.equal(res.code, 503);
  assert.deepEqual(res.body, {ok: false, code: 'BOOTSTRAP_UNAVAILABLE'});
});
