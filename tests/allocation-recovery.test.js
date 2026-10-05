'use strict';
// Prepared source only. Never executed in the delegated preparation lane.
// Firestore/Compute/Cloud Build below are synthetic injected fixtures, not SDK
// or transaction-emulator qualification and not permission evidence.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createAllocationRecovery } = require('../cloud-functions/webhook-handler/allocation-recovery');

function identity(event) {
  const fields = [event.repo_owner, event.repo_name, event.run_id, event.job_id,
    event.run_attempt || '1'].map(String);
  const key = createHash('sha256').update(JSON.stringify(fields)).digest('hex');
  const prefix = `runner-${fields[0]}-${fields[1]}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 38).replace(/-+$/, '');
  return { key, name: `${prefix}-${key.slice(0, 24)}` };
}
function fixture() {
  const project = 'example-project'; const zone = 'example-region1-a';
  const event = { repo_owner: 'example', repo_name: 'fixture', run_id: '1', job_id: '2', run_attempt: '1',
    labels: ['self-hosted', 'fixture-route'] };
  const allocation = identity(event); const token = '00000000-0000-4000-8000-000000000001';
  const createdMs = 1000000; const ttl = 600000; let now = createdMs + 10000;
  const worker = 'worker@example-project.iam.gserviceaccount.com';
  const broker = 'https://broker.example.invalid';
  const entry = { name: allocation.name, zone, token, state: 'unknown', buildId: 'fixture-build',
    project, workerServiceAccountEmail: worker, workerServiceAccountUniqueId: '123456',
    brokerUrl: broker, bootstrapExpiresAtMs: createdMs + ttl, creationStarted: false };
  const records = { 'provisioning_pools/global': { entries: JSON.stringify({ [allocation.key]: entry }), untouched: 'preserved' },
    ['job_provisioning/' + allocation.key]: { done: false, state: 'pending', event: JSON.stringify(event) } };
  const edits = [];
  const firestore = { collection: name => ({ doc: id => name + '/' + id }), async runTransaction(callback) {
    const writes = [];
    const value = await callback({ get: async ref => ({ exists: Object.hasOwn(records, ref),
      data: () => structuredClone(records[ref]) }), update: (ref, fields) => writes.push([ref, fields]) });
    for (const [ref, fields] of writes) { records[ref] = { ...records[ref], ...fields }; edits.push([ref, fields]); }
    return value;
  } };
  const zoneLink = `https://www.googleapis.com/compute/v1/projects/${project}/zones/${zone}`;
  const attrs = { 'allocation-key': allocation.key, 'reservation-token': token,
    'repo-owner': event.repo_owner, 'repo-name': event.repo_name,
    'run-id': event.run_id, 'job-id': event.job_id, 'run-attempt': event.run_attempt,
    'vm-id': entry.name, 'allocation-broker-url': broker,
    'runner-count': '1', 'worker-profile': 'trusted-private-one-job',
    'bootstrap-expires-at-ms': String(entry.bootstrapExpiresAtMs) };
  const instance = { selfLink: zoneLink + '/instances/' + entry.name, zone: zoneLink, name: entry.name,
    status: 'RUNNING', id: '3', creationTimestamp: new Date(createdMs).toISOString(),
    scheduling: { provisioningModel: 'SPOT', instanceTerminationAction: 'DELETE', automaticRestart: false },
    serviceAccounts: [{ email: worker, scopes: [] }],
    networkInterfaces: [{ networkIP: '10.0.0.2', network: 'fixture-private-network', subnetwork: 'fixture-private-subnet' }],
    metadata: { items: Object.entries(attrs).map(([key, value]) => ({ key, value })) } };
  let getHook; let buildHook; let absent = false;
  let build = { id: entry.buildId, projectId: project, status: 'FAILURE' };
  const calls = { compute: [], build: [] };
  const compute = { async get(args) {
    calls.compute.push(args);
    if (getHook) return getHook(args);
    if (absent) throw Object.assign(new Error('fixture_not_found'), { code: 5 });
    return [structuredClone(instance)];
  } };
  const cloudBuild = { async getBuild(args) {
    calls.build.push(args); if (buildHook) return buildHook(args); return [structuredClone(build)];
  } };
  const recovery = createAllocationRecovery({ firestore, compute, cloudBuild, project, zone,
    repositoryOwner: 'example', repositoryName: 'fixture', workerServiceAccountEmail: worker,
    workerServiceAccountUniqueId: '123456', brokerUrl: broker, bootstrapTTLms: ttl,
    registeredLabels: ['self-hosted', 'fixture-route'], routingLabel: 'fixture-route', identity, clock: () => now });
  const getEntry = () => JSON.parse(records['provisioning_pools/global'].entries)[allocation.key];
  const editEntry = fields => {
    const entries = JSON.parse(records['provisioning_pools/global'].entries);
    entries[allocation.key] = { ...entries[allocation.key], ...fields };
    records['provisioning_pools/global'].entries = JSON.stringify(entries);
  };
  return { key: allocation.key, entry, instance, attrs, records, edits, calls, recovery, createdMs, ttl,
    job: () => records['job_provisioning/' + allocation.key], getEntry, editEntry,
    setNow: value => { now = value; }, setAbsent: () => { absent = true; },
    setBuild: value => { build = value; }, setGetHook: value => { getHook = value; }, setBuildHook: value => { buildHook = value; },
    attr: (key, value) => { const row = instance.metadata.items.find(item => item.key === key); row.value = value; } };
}

test('manual stale ownership cannot retarget recovery to a new reservation or incarnation', async () => {
  for (const patch of [{token: '00000000-0000-4000-8000-000000000099'}, {instanceId: '99'},
    {instanceCreationTimestamp: '2000-01-01T00:00:00Z'}, {claimId: 'different-claim'}, {project: 'other-project'}]) {
    const f = fixture(); const receipt = {version: 1, state: 'claimed', claimId: 'fixture-claim'};
    f.editEntry({bootstrap: receipt, instanceId: '3', instanceCreationTimestamp: f.instance.creationTimestamp});
    f.job().bootstrap = JSON.stringify(receipt);
    const request = {key: f.key, token: f.entry.token, name: f.entry.name, zone: f.entry.zone,
      project: f.entry.project, instanceId: '3', instanceCreationTimestamp: f.instance.creationTimestamp,
      claimId: receipt.claimId, ...patch};
    assert.equal((await f.recovery.hydrateAllocation(f.key, request)).reason, 'request-ownership-changed');
    assert.equal((await f.recovery.recoverAbsentAllocation(f.key, request)).reason, 'request-ownership-changed');
    assert.deepEqual(f.calls.compute, []); assert.deepEqual(f.calls.build, []); assert.equal(f.edits.length, 0);
  }
});
test('manual exact binding preserves known orphan evidence while unknown incarnation stays closed', async () => {
  const f = fixture(); const receipt = {version: 1, state: 'claimed', claimId: 'fixture-claim',
    expiresAtMs: f.entry.bootstrapExpiresAtMs, mintOutcome: 'observed', runnerId: 4,
    runnerName: f.entry.name, runnerLabels: ['self-hosted', 'fixture-route']};
  const request = {key: f.key, token: f.entry.token, name: f.entry.name, zone: f.entry.zone,
    project: f.entry.project, instanceId: '3', instanceCreationTimestamp: f.instance.creationTimestamp, claimId: receipt.claimId};
  f.setAbsent();
  assert.equal((await f.recovery.recoverAbsentAllocation(f.key, request)).reason, 'request-ownership-changed');
  assert.equal(f.calls.compute.length, 0);
  f.editEntry({bootstrap: receipt, instanceId: '3', instanceCreationTimestamp: f.instance.creationTimestamp});
  f.job().bootstrap = JSON.stringify(receipt);
  assert.equal((await f.recovery.recoverAbsentAllocation(f.key, request)).reason, 'known-runner-orphan-charged');
  assert.equal(f.getEntry().state, 'orphaned'); assert.equal(f.calls.build.length, 0);
});
test('interrupted create-before-bind hydrates exact current owned incarnation, retaining immutable expiry', async () => {
  const f = fixture(); const before = f.entry.bootstrapExpiresAtMs;
  assert.deepEqual(await f.recovery.hydrateAllocation(f.key), { status: 'hydrated', reason: 'authoritative-incarnation-bound' });
  assert.equal(f.getEntry().instanceId, '3'); assert.equal(f.getEntry().instanceCreationTimestamp, f.instance.creationTimestamp);
  assert.equal(f.getEntry().state, 'active'); assert.equal(f.getEntry().bootstrapExpiresAtMs, before);
  assert.equal(f.getEntry().token, f.entry.token); assert.equal(f.getEntry().buildId, f.entry.buildId);
  assert.equal(f.job().bootstrap, undefined); assert.equal(f.records['provisioning_pools/global'].untouched, 'preserved');
  assert.deepEqual(f.calls.compute, [{ project: 'example-project', zone: f.entry.zone, instance: f.entry.name }]);
  assert.equal(f.calls.build.length, 0);
});
test('already hydrated is idempotent without new writes or TTL renewal', async () => {
  const f = fixture(); await f.recovery.hydrateAllocation(f.key); const count = f.edits.length;
  const before = JSON.stringify(f.records);
  assert.deepEqual(await f.recovery.hydrateAllocation(f.key), { status: 'hydrated', reason: 'already-bound' });
  assert.equal(f.edits.length, count); assert.equal(JSON.stringify(f.records), before);
});
test('historical missing expiry can bind only the original bounded metadata deadline', async () => {
  const f = fixture();
  const entries = JSON.parse(f.records['provisioning_pools/global'].entries); delete entries[f.key].bootstrapExpiresAtMs;
  f.records['provisioning_pools/global'].entries = JSON.stringify(entries);
  assert.equal((await f.recovery.hydrateAllocation(f.key)).status, 'hydrated');
  assert.equal(f.getEntry().bootstrapExpiresAtMs, Number(f.attrs['bootstrap-expires-at-ms']));
});
test('unknown accepted build identity is not invented when positive owned VM is hydrated', async () => {
  const f = fixture(); const entries = JSON.parse(f.records['provisioning_pools/global'].entries);
  delete entries[f.key].buildId; f.records['provisioning_pools/global'].entries = JSON.stringify(entries);
  assert.equal((await f.recovery.hydrateAllocation(f.key)).status, 'hydrated');
  assert.equal(f.getEntry().buildId, undefined);
});
test('expired allocation remains charged and no deadline is extended', async () => {
  const f = fixture(); f.setNow(f.entry.bootstrapExpiresAtMs + 1);
  assert.deepEqual(await f.recovery.hydrateAllocation(f.key), { status: 'preserved', reason: 'bootstrap-expired-no-extension' });
  assert.equal(f.getEntry().bootstrapExpiresAtMs, f.entry.bootstrapExpiresAtMs); assert.equal(f.edits.length, 0);
});
test('recorded old incarnation cannot be rebound to a same-name replacement', async () => {
  for (const fields of [{ instanceId: '9' }, { instanceCreationTimestamp: '1970-01-01T00:00:01.000Z' }]) {
    const f = fixture(); f.editEntry(fields);
    assert.equal((await f.recovery.hydrateAllocation(f.key)).status, 'preserved'); assert.equal(f.edits.length, 0);
  }
});
test('mismatched project/zone/name/nonce/job/profile/count/broker/expiry preserve charge', async () => {
  const changes = [f => { f.instance.selfLink = f.instance.selfLink.replace('example-project', 'other-project'); },
    f => { f.instance.zone = 'other-zone'; }, f => { f.instance.name = 'other-worker'; },
    f => { f.attr('reservation-token', '00000000-0000-4000-8000-000000000009'); },
    f => { f.attr('job-id', '9'); }, f => { f.attr('worker-profile', 'shared-host'); },
    f => { f.attr('runner-count', '2'); }, f => { f.attr('allocation-broker-url', 'https://other.example.invalid'); },
    f => { f.attr('bootstrap-expires-at-ms', String(f.entry.bootstrapExpiresAtMs + 1)); }];
  for (const change of changes) { const f = fixture(); change(f);
    assert.equal((await f.recovery.hydrateAllocation(f.key)).status, 'preserved'); assert.equal(f.edits.length, 0); }
});
test('wrong worker identity, scopes, Spot action, public NIC or incomplete SDK fields preserve', async () => {
  const changes = [f => { f.instance.serviceAccounts[0].email = 'other@example-project.iam.gserviceaccount.com'; },
    f => { f.instance.serviceAccounts[0].scopes = ['fixture_management_scope']; },
    f => { delete f.instance.serviceAccounts[0].scopes; },
    f => { f.instance.scheduling.instanceTerminationAction = 'STOP'; },
    f => { f.instance.scheduling.automaticRestart = true; },
    f => { f.instance.networkInterfaces[0].accessConfigs = [{}]; },
    f => { f.instance.networkInterfaces[0].networkIP = '203.0.113.2'; },
    f => { f.instance.status = 'STAGING'; }];
  for (const change of changes) { const f = fixture(); change(f);
    assert.equal((await f.recovery.hydrateAllocation(f.key)).status, 'preserved'); assert.equal(f.edits.length, 0); }
});
test('duplicate metadata keys and malformed scope arrays cannot assert ownership', async () => {
  const f = fixture(); f.instance.metadata.items.push({ key: 'runner-count', value: '1' });
  assert.equal((await f.recovery.hydrateAllocation(f.key)).status, 'preserved'); assert.equal(f.edits.length, 0);
});
test('reservation or job evidence changed during GET blocks hydration CAS', async () => {
  for (const change of [f => f.editEntry({ token: '00000000-0000-4000-8000-000000000009' }),
    f => f.editEntry({ buildId: 'other-build' }), f => { f.job().done = true; }]) {
    const f = fixture(); f.setGetHook(async () => { change(f); return [structuredClone(f.instance)]; });
    assert.deepEqual(await f.recovery.hydrateAllocation(f.key), { status: 'preserved', reason: 'ownership-changed' });
    assert.equal(f.edits.length, 0);
  }
});
test('unknown Compute errors are redacted and never imply absence', async () => {
  for (const code of [14, 404, '5', undefined]) {
    const f = fixture(); f.setGetHook(async () => { throw Object.assign(new Error('synthetic_private_error'), { code }); });
    const result = await f.recovery.hydrateAllocation(f.key);
    assert.deepEqual(result, { status: 'preserved', reason: 'compute-inspection-unknown' });
    assert.equal(JSON.stringify(result).includes('synthetic_private_error'), false); assert.equal(f.edits.length, 0);
  }
});
test('only exact code5 produces absent disposition, no inventory API exists', async () => {
  const f = fixture(); f.setAbsent();
  assert.deepEqual(await f.recovery.hydrateAllocation(f.key), { status: 'absent', reason: 'authoritative-get-not-found' });
  assert.equal(f.edits.length, 0); assert.equal(f.calls.build.length, 0);
});
test('known observed receipt on absent VM stays charged and marked orphaned', async () => {
  const f = fixture(); const receipt = { version: 1, state: 'claimed', claimId: 'fixture-claim',
    expiresAtMs: f.entry.bootstrapExpiresAtMs, mintOutcome: 'observed', runnerId: 4,
    runnerName: f.entry.name, runnerLabels: ['self-hosted', 'fixture-route'] };
  f.editEntry({ bootstrap: receipt, instanceId: '3', instanceCreationTimestamp: f.instance.creationTimestamp });
  f.job().bootstrap = JSON.stringify(receipt); f.setAbsent();
  assert.deepEqual(await f.recovery.recoverAbsentAllocation(f.key), { status: 'preserved', reason: 'known-runner-orphan-charged' });
  assert.equal(f.getEntry().bootstrap.runnerId, 4); assert.equal(f.getEntry().recovery.state, 'orphaned');
  assert.equal(f.getEntry().state, 'orphaned');
  assert.equal(f.calls.build.length, 0); assert.equal(f.job().bootstrap, JSON.stringify(receipt));
  assert.equal((await f.recovery.recoverAbsentAllocation(f.key)).reason, 'known-runner-orphan-charged');
  assert.equal(f.getEntry().state, 'orphaned');
});
test('unknown mint receipt or association on absence is retained, never reminted or released', async () => {
  const f = fixture(); const receipt = { version: 1, state: 'claimed', claimId: 'fixture-claim' };
  f.editEntry({ bootstrap: receipt }); f.job().bootstrap = JSON.stringify(receipt); f.setAbsent();
  assert.equal((await f.recovery.recoverAbsentAllocation(f.key)).status, 'preserved');
  assert.equal(f.getEntry().recovery.state, 'unknown'); assert.equal(f.getEntry().bootstrap.state, 'claimed');
});
test('mismatched mirrored receipts preserve without rewriting', async () => {
  const f = fixture(); f.editEntry({ bootstrap: { state: 'claimed' } });
  f.job().bootstrap = JSON.stringify({ state: 'issued' }); f.setAbsent();
  assert.equal((await f.recovery.recoverAbsentAllocation(f.key)).status, 'preserved'); assert.equal(f.edits.length, 0);
});
test('receipt, completion and pending cleanup evidence prevent otherwise failed-build release', async () => {
  for (const field of ['completion', 'cleanup', 'pendingCleanup', 'bootstrapHistory',
    'actualJob', 'actualCompletion', 'associationConflict', 'executedBy']) {
    const f = fixture(); f.job()[field] = '{}'; f.setAbsent();
    assert.equal((await f.recovery.recoverAbsentAllocation(f.key)).status, 'preserved'); assert.ok(f.getEntry());
    assert.equal(f.calls.build.length, 0);
  }
});
test('actual association evidence present on the pool entry also prohibits release', async () => {
  for (const field of ['actualJob', 'actualCompletion', 'associationConflict', 'executedBy']) {
    const f = fixture(); f.editEntry({ [field]: null }); f.setAbsent();
    assert.equal((await f.recovery.recoverAbsentAllocation(f.key)).status, 'preserved');
    assert.ok(f.getEntry()); assert.equal(f.calls.build.length, 0);
  }
});
test('failed terminal build plus repeated authoritative absence releases only unissued unchanged slot', async () => {
  const f = fixture(); f.setAbsent(); const event = f.job().event;
  assert.deepEqual(await f.recovery.recoverAbsentAllocation(f.key), { status: 'released', reason: 'failed-build-and-authoritative-absence-unissued' });
  assert.equal(f.getEntry(), undefined); assert.equal(f.job().state, 'waiting'); assert.equal(f.job().event, event);
  assert.equal(f.calls.compute.length, 2); assert.equal(f.calls.build.length, 1);
});
test('accepted creation and missing legacy creation flag stay charged despite failed build and exact GET5', async () => {
  for (const flag of [true, undefined, 'false']) {
    const f = fixture(); f.setAbsent();
    const entries = JSON.parse(f.records['provisioning_pools/global'].entries);
    if (flag === undefined) delete entries[f.key].creationStarted;
    else entries[f.key].creationStarted = flag;
    f.records['provisioning_pools/global'].entries = JSON.stringify(entries);
    assert.deepEqual(await f.recovery.recoverAbsentAllocation(f.key), { status: 'preserved', reason: 'compute-creation-outcome-unknown' });
    assert.equal(f.calls.build.length, 0); assert.equal(f.edits.length, 0); assert.ok(f.getEntry());
  }
});
test('successful/running/unknown or wrongly scoped builds on absence retain charge', async () => {
  for (const build of [{ id: 'fixture-build', projectId: 'example-project', status: 'SUCCESS' },
    { id: 'fixture-build', projectId: 'example-project', status: 'WORKING' },
    { id: 'fixture-build', projectId: 'other-project', status: 'FAILURE' },
    { id: 'other-build', projectId: 'example-project', status: 'FAILURE' }, {}]) {
    const f = fixture(); f.setAbsent(); f.setBuild(build);
    assert.equal((await f.recovery.recoverAbsentAllocation(f.key)).status, 'preserved'); assert.ok(f.getEntry()); assert.equal(f.edits.length, 0);
  }
});
test('build read failure or missing build ID never releases absent slot', async () => {
  const f = fixture(); f.setAbsent(); f.setBuildHook(async () => { throw new Error('fixture_unknown'); });
  assert.equal((await f.recovery.recoverAbsentAllocation(f.key)).status, 'preserved'); assert.equal(f.edits.length, 0);
  const other = fixture(); other.setAbsent(); const entries = JSON.parse(other.records['provisioning_pools/global'].entries);
  delete entries[other.key].buildId; other.records['provisioning_pools/global'].entries = JSON.stringify(entries);
  assert.equal((await other.recovery.recoverAbsentAllocation(other.key)).status, 'preserved'); assert.equal(other.calls.build.length, 0);
});
test('reservation or receipt changes during build read prevent release', async () => {
  for (const change of [f => f.editEntry({ token: '00000000-0000-4000-8000-000000000009' }),
    f => { f.job().completion = '{}'; }]) {
    const f = fixture(); f.setAbsent(); f.setBuildHook(async () => { change(f);
      return [{ id: 'fixture-build', projectId: 'example-project', status: 'FAILURE' }]; });
    assert.equal((await f.recovery.recoverAbsentAllocation(f.key)).status, 'preserved'); assert.equal(f.edits.length, 0); assert.ok(f.getEntry());
  }
});
test('a reappearing instance on second GET blocks failed-build release', async () => {
  const f = fixture(); let count = 0;
  f.setGetHook(async () => { if (++count === 1) throw Object.assign(new Error('fixture_absent'), { code: 5 });
    return [structuredClone(f.instance)]; });
  assert.deepEqual(await f.recovery.recoverAbsentAllocation(f.key), { status: 'preserved', reason: 'absence-no-longer-confirmed' });
  assert.equal(f.edits.length, 0);
});
test('clock rollback after snapshot does not make a hydration deadline fresh', async () => {
  const f = fixture(); f.setGetHook(async () => { f.setNow(f.createdMs + 1); return [structuredClone(f.instance)]; });
  assert.deepEqual(await f.recovery.hydrateAllocation(f.key), { status: 'preserved', reason: 'clock-unverified' });
  assert.equal(f.edits.length, 0);
});
