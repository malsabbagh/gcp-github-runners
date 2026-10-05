'use strict';
// Hermetic injected fixtures; results do not qualify actual SDK/Firestore behavior.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAllocationBootstrapStore } = require('../cloud-functions/webhook-handler/allocation-bootstrap-store');
const { createAllocationBootstrapBroker } = require('../cloud-functions/webhook-handler/allocation-bootstrap-broker');
const { createManagedInstanceVerifier } = require('../cloud-functions/webhook-handler/managed-instance-verifier');
const { createBootstrapHttpHandler } = require('../cloud-functions/webhook-handler/bootstrap-http');
const { createGitHubAppRunnerAdapter } = require('../cloud-functions/webhook-handler/github-app-runner-adapter');

function fixture() {
  let now = 100000;
  const key = 'a'.repeat(64); const nonce = '00000000-0000-4000-8000-000000000001';
  const request = { allocationKey: key, reservationToken: nonce, repositoryOwner: 'example',
    repositoryName: 'fixture', runId: '1', jobId: '2', attempt: '1', instanceId: '3' };
  const entry = { name: 'fixture-worker', token: nonce, state: 'active', zone: 'example-region1-a',
    project: 'example-project', instanceId: '3', instanceCreationTimestamp: '2026-10-05T00:00:00.000Z',
    workerServiceAccountEmail: 'worker@example-project.iam.gserviceaccount.com',
    workerServiceAccountUniqueId: '123456', bootstrapExpiresAtMs: 200000 };
  const records = { 'provisioning_pools/global': { entries: JSON.stringify({ [key]: entry }) },
    ['job_provisioning/' + key]: { done: false, state: 'waiting', event: JSON.stringify({
      repo_owner: 'example', repo_name: 'fixture', run_id: '1', job_id: '2', run_attempt: '1',
      labels: ['self-hosted', 'fixture-route'] }) } };
  const firestore = { collection: name => ({ doc: id => name + '/' + id }),
    async runTransaction(callback) {
      const pending = [];
      const result = await callback({ get: async ref => ({ exists: Object.hasOwn(records, ref),
        data: () => structuredClone(records[ref]) }), update: (ref, patch) => pending.push([ref, patch]) });
      for (const [ref, patch] of pending) records[ref] = { ...records[ref], ...patch };
      return result;
    } };
  const store = createAllocationBootstrapStore({ firestore, project: entry.project, zone: entry.zone,
    repositoryOwner: 'example', repositoryName: 'fixture', workerServiceAccountEmail: entry.workerServiceAccountEmail,
    workerServiceAccountUniqueId: entry.workerServiceAccountUniqueId,
    registeredLabels: ['self-hosted', 'fixture-route'], routingLabel: 'fixture-route', clock: () => now });
  const identity = { project: entry.project, zone: entry.zone, name: entry.name, instanceId: entry.instanceId,
    incarnation: entry.instanceCreationTimestamp, serviceAccountEmail: entry.workerServiceAccountEmail,
    serviceAccountUniqueId: entry.workerServiceAccountUniqueId, expiresAtMs: 300000, checkedAtMs: now };
  const material = { encodedJitConfig: 'synthetic_jit_fixture', runnerId: 4, runnerName: entry.name,
    releaseBeforeMs: 200000, providerExpiresAtMs: null };
  const broker = (mint = async () => material, qualified = true) => createAllocationBootstrapBroker({ store,
    verifyIdentity: async () => ({ ...identity, checkedAtMs: now }), github: { mintJit: mint },
    clock: () => now, newClaimId: () => '00000000-0000-4000-8000-000000000002',
    jitProviderLifetimeQualified: qualified });
  return { request, entry, records, store, identity, material, broker, key,
    clock: () => now,
    setNow: value => { now = value; }, pool: () => JSON.parse(records['provisioning_pools/global'].entries)[key] };
}

async function injectedAdapter(f, response) {
  return createGitHubAppRunnerAdapter({ appId: 1, installationId: 2, repositoryId: 3,
    repositoryOwner: 'example', repositoryName: 'fixture', runnerGroupId: 1,
    jitReleaseWindowMs: 1000, clock: f.clock,
    privateKeyProvider: async () => 'synthetic_fixture_private_key'.repeat(4),
    octokitFactory: async () => ({
      auth: async () => ({ tokenType: 'installation', permissions: { administration: 'write' } }),
      request: async route => {
        if (route === 'GET /repos/{owner}/{repo}')
          return { data: { id: 3, full_name: 'example/fixture', private: true } };
        assert.equal(route, 'POST /repos/{owner}/{repo}/actions/runners/generate-jitconfig');
        return { data: response() };
      }
    }) });
}

function assertConsumedKnownRunner(f, response) {
  assert.deepEqual(response, { ok: false, code: 'BOOTSTRAP_UNAVAILABLE' });
  assert.equal(f.pool().bootstrap.state, 'claimed');
  assert.equal(f.pool().bootstrap.runnerId, 4);
  assert.equal(f.pool().bootstrap.runnerName, f.entry.name);
  assert.equal(f.pool().state, 'active');
  assert.deepEqual(JSON.parse(f.records['job_provisioning/' + f.key].bootstrap), f.pool().bootstrap);
  assert.equal(JSON.stringify(f.records).includes('synthetic_jit_fixture'), false);
  assert.equal(Object.hasOwn(response, 'encodedJitConfig'), false);
}

test('expired mint retains owned runner identity through broker and adapter rejection without remint', async () => {
  for (const mode of ['broker', 'adapter']) {
    const f = fixture(); let calls = 0;
    const adapter = await injectedAdapter(f, () => {
      f.setNow(200001);
      return { runner: { id: 4, name: f.entry.name }, encoded_jit_config: 'synthetic_jit_fixture' };
    });
    const broker = f.broker(async input => {
      calls++;
      if (mode === 'adapter') return adapter.mintJit(input);
      f.setNow(200001); return f.material;
    });
    assertConsumedKnownRunner(f, await broker.exchange(f.request, 'fixture'));
    assert.equal((await broker.exchange(f.request, 'fixture')).ok, false);
    assert.equal(calls, 1);
  }
});

test('malformed material retains owned runner identity through broker and adapter rejection without remint', async () => {
  for (const mode of ['broker', 'adapter']) {
    const f = fixture(); let calls = 0;
    const adapter = await injectedAdapter(f, () => ({
      runner: { id: 4, name: f.entry.name }, encoded_jit_config: null
    }));
    const broker = f.broker(async input => {
      calls++;
      return mode === 'adapter' ? adapter.mintJit(input) : {
        runnerId: 4, runnerName: f.entry.name, encodedJitConfig: null
      };
    });
    assertConsumedKnownRunner(f, await broker.exchange(f.request, 'fixture'));
    assert.equal((await broker.exchange(f.request, 'fixture')).code, 'BOOTSTRAP_REPLAY_REJECTED');
    assert.equal(calls, 1);
  }
});

test('SDK-facing store writes same pool and JSON-string job receipt without provider material', async () => {
  const f = fixture(); const response = await f.broker().exchange(f.request, 'synthetic_assertion');
  assert.equal(response.ok, true); assert.equal(f.pool().bootstrap.state, 'issued');
  assert.equal(f.pool().runnerIdentity.id, 4);
  assert.equal(typeof f.records['job_provisioning/' + f.key].bootstrap, 'string');
  assert.equal(JSON.stringify(f.records).includes('synthetic_jit_fixture'), false);
  assert.equal((await f.broker().exchange(f.request, 'synthetic_assertion')).code, 'BOOTSTRAP_REPLAY_REJECTED');
});
test('wrong repository/job/attempt/nonce/instance never consumes or mints', async () => {
  for (const key of ['repositoryName', 'jobId', 'attempt', 'reservationToken', 'instanceId']) {
    const f = fixture(); let calls = 0; const request = { ...f.request, [key]: key === 'reservationToken' ?
      '00000000-0000-4000-8000-000000000009' : key === 'repositoryName' ? 'other' : '9' };
    assert.equal((await f.broker(async () => { calls++; return f.material; }).exchange(request, 'fixture')).ok, false);
    assert.equal(calls, 0); assert.equal(f.pool().bootstrap, undefined);
  }
});
test('cancellation during mint preserves consumed issuance and known orphan identity', async () => {
  const f = fixture(); const result = await f.broker(async () => {
    f.records['job_provisioning/' + f.key].done = true; return f.material;
  }).exchange(f.request, 'fixture');
  assert.equal(result.ok, false); assert.equal(f.pool().bootstrap.state, 'claimed');
  assert.equal(f.pool().bootstrap.runnerId, 4); assert.equal(f.pool().state, 'active');
});
test('expiry during mint releases no material and retains capacity', async () => {
  const f = fixture(); const result = await f.broker(async () => {
    f.setNow(200001); return f.material;
  }).exchange(f.request, 'fixture');
  assert.equal(result.ok, false); assert.equal(f.pool().bootstrap.state, 'claimed');
  assert.equal(f.pool().state, 'active');
});
test('uncertain provider mint is consumed, never retried automatically', async () => {
  const f = fixture(); let calls = 0;
  const broker = f.broker(async () => { calls++; throw new Error('synthetic_private_error'); });
  assert.deepEqual(await broker.exchange(f.request, 'fixture'), { ok: false, code: 'BOOTSTRAP_UNAVAILABLE' });
  assert.equal((await broker.exchange(f.request, 'fixture')).code, 'BOOTSTRAP_REPLAY_REJECTED');
  assert.equal(calls, 1);
});
test('unqualified JIT deployment lock rejects before claim', async () => {
  const f = fixture(); assert.equal((await f.broker(undefined, false).exchange(f.request, 'fixture')).ok, false);
  assert.equal(f.pool().bootstrap, undefined);
});
test('same service account without exact Google Compute identity is rejected', async () => {
  const f = fixture(); const allocation = await f.store.readBootstrapAllocation(f.request);
  const verify = createManagedInstanceVerifier({ audience: 'https://broker.example.invalid',
    clock: () => 100000, idTokenClient: { verifyIdToken: async () => ({ getPayload: () => ({
      iss: 'https://accounts.google.com', aud: 'https://broker.example.invalid', email_verified: true,
      email: f.entry.workerServiceAccountEmail, sub: f.entry.workerServiceAccountUniqueId,
      iat: 50, exp: 300, google: { compute_engine: { instance_id: '9', instance_name: f.entry.name,
        project_id: f.entry.project, zone: f.entry.zone } } }) }) },
    instancesClient: { get: async () => { throw new Error('must_not_get'); } } });
  await assert.rejects(verify('synthetic_assertion'.repeat(8), allocation), /BOOTSTRAP_IDENTITY_REJECTED/);
});
test('HTTP transport proof defaults closed without broker call', async () => {
  let called = false; const handler = createBootstrapHttpHandler({ broker: { exchange: () => { called = true; } } });
  const res = { set() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  await handler({}, res); assert.equal(res.code, 403); assert.equal(called, false);
});
