'use strict';
// Unrun source-only fixtures. Closure: node:test, node:assert/strict, the new
// module and root's adjacent pure job-identity.js (itself node:crypto only).
const test = require('node:test');
const assert = require('node:assert/strict');
const { identity } = require('../cloud-functions/webhook-handler/job-identity');
const { createActualJobAssociation, validatedActualCompletion } = require('../cloud-functions/webhook-handler/actual-job-association');
const clone = value => structuredClone(value);
function fixture() {
  const ownerEvent = { repo_owner: 'Example', repo_name: 'Repo', run_id: '20', job_id: '10', run_attempt: '1', labels: ['self-hosted', 'private-one-job'] };
  const ownerKey = identity(ownerEvent).key, name = identity(ownerEvent).name;
  const bootstrap = { version: 1, state: 'issued', claimId: '11111111-1111-4111-8111-111111111111',
    runnerId: 7, runnerName: name, runnerLabels: [...ownerEvent.labels],
    issuedAtMs: 1000, releaseBeforeMs: 2000, providerExpiresAtMs: null };
  const entry = { name, token: '22222222-2222-4222-8222-222222222222', state: 'active', zone: 'us-central1-a',
    project: 'example-project', instanceId: '123456789', instanceCreationTimestamp: '2026-10-05T10:00:00Z',
    runnerIdentity: { id: 7, name, labels: ownerEvent.labels }, bootstrap };
  const documents = new Map([
    ['provisioning_pools/global', { entries: JSON.stringify({ [ownerKey]: entry }) }],
    ['job_provisioning/' + ownerKey, { done: false, state: 'pending', event: JSON.stringify(ownerEvent), bootstrap: JSON.stringify(bootstrap) }]
  ]);
  let queue = Promise.resolve(), transactionCount = 0, retryMutation;
  const reads = [];
  const firestore = {
    collection(collection) { return { doc(id) { return { key: collection + '/' + id }; } }; },
    runTransaction(fn) {
      const task = queue.then(async () => {
        transactionCount++;
        async function attempt() {
          let writing = false;
          const writes = [];
          const result = await fn({
            async get(ref) {
              assert.equal(writing, false, 'all reads must precede writes');
              reads.push(ref.key);
              const data = documents.get(ref.key);
              return { exists: data !== undefined, data: () => clone(data) };
            },
            set(ref, data) { writing = true; writes.push([ref.key, clone(data)]); }
          });
          return { result, writes };
        }
        let current = await attempt();
        if (retryMutation) {
          const mutation = retryMutation; retryMutation = undefined;
          mutation(); // First attempt is discarded, as with Firestore conflict retry.
          current = await attempt();
        }
        for (const [key, data] of current.writes) documents.set(key, data);
        return current.result;
      });
      queue = task.catch(() => {});
      return task;
    }
  };
  const association = createActualJobAssociation({ firestore, repositoryOwner: 'example', repositoryName: 'repo', clock: () => 2000000 });
  function pool() { return JSON.parse(documents.get('provisioning_pools/global').entries); }
  function setPool(value) { documents.set('provisioning_pools/global', { entries: JSON.stringify(value) }); }
  function job() { return clone(documents.get('job_provisioning/' + ownerKey)); }
  const event = { ...ownerEvent, job_id: '11', action: 'in_progress', verifiedWebhook: true, runner_id: 7, runner_name: name };
  return { association, documents, ownerKey, ownerEvent, entry, event, pool, setPool, job, reads,
    transactions: () => transactionCount, retry(fn) { retryMutation = fn; } };
}

test('serialized label arrays bind by value and changed mirrored labels reject completion', async () => {
  const f = fixture();
  assert.equal((await f.association.observe({...f.event, action: 'completed'})).status, 'completed');
  const entry = f.pool()[f.ownerKey], job = f.job();
  assert.equal(validatedActualCompletion({entry, job}), true);
  const receipt = JSON.parse(job.bootstrap); receipt.runnerLabels[1] = 'changed-route';
  job.bootstrap = JSON.stringify(receipt);
  assert.equal(validatedActualCompletion({entry, job}), false);
});
test('unverified, unrelated, unsupported and malformed events cannot write association', async () => {
  const f = fixture(); const before = clone(f.documents);
  for (const changes of [{ verifiedWebhook: false }, { verifiedWebhook: 'true' }, { repo_owner: 'other' },
    { action: 'queued' }, { runner_id: 0 }, { runner_id: Number.MAX_SAFE_INTEGER + 1 }, { runner_name: 'bad/name' }]) {
    assert.equal((await f.association.observe({ ...f.event, ...changes })).status, 'ignored');
  }
  assert.equal(f.transactions(), 0); assert.deepEqual(f.documents, before);
});
test('different actual dispatch is bound without completing or replacing original demand', async () => {
  const f = fixture(); const result = await f.association.observe(f.event);
  assert.equal(result.status, 'associated');
  const entry = f.pool()[f.ownerKey], job = f.job();
  assert.equal(entry.actualJob.key, identity(f.event).key);
  assert.equal(entry.actualJob.repositoryOwner, 'Example');
  assert.equal(entry.actualJob.runnerId, '7'); assert.equal(entry.actualJob.reservationToken, f.entry.token);
  assert.equal(entry.actualJob.instanceId, f.entry.instanceId); assert.equal(entry.actualJob.claimId, f.entry.bootstrap.claimId);
  assert.equal(job.done, false); assert.equal(entry.demandDone, undefined);
  assert.deepEqual(JSON.parse(job.event), f.ownerEvent);
  assert.deepEqual(JSON.parse(job.actualJob), entry.actualJob); assert.equal(job.actualCompletion, undefined);
  assert.equal(validatedActualCompletion({ entry, job }), false);
  const actualDemand = f.documents.get('job_provisioning/' + identity(f.event).key);
  assert.equal(actualDemand.done, false); assert.equal(actualDemand.state, 'running');
  assert.deepEqual(JSON.parse(actualDemand.executedBy), { version: 1, allocationKey: f.ownerKey,
    actualJobKey: identity(f.event).key, reservationToken: f.entry.token,
    instanceId: f.entry.instanceId, instanceCreationTimestamp: f.entry.instanceCreationTimestamp,
    runnerId: '7', runnerName: f.entry.name, claimId: f.entry.bootstrap.claimId, state: 'running' });
  assert.equal(actualDemand.actualJob, undefined);
  assert.ok(f.reads.includes('job_provisioning/' + identity(f.event).key));
});
test('completed before in-progress remains terminal and late progress is an exact duplicate', async () => {
  const f = fixture(); assert.equal((await f.association.observe({ ...f.event, action: 'completed' })).status, 'completed');
  const before = clone(f.documents);
  assert.equal((await f.association.observe(f.event)).status, 'duplicate');
  assert.equal((await f.association.observe({ ...f.event, action: 'completed' })).status, 'duplicate');
  assert.deepEqual(f.documents, before);
  assert.equal(validatedActualCompletion({ entry: f.pool()[f.ownerKey], job: f.job() }), true);
  assert.equal(f.job().done, false);
});
test('running observation advances once to completed with matched mirrors', async () => {
  const f = fixture(); await f.association.observe(f.event);
  assert.equal((await f.association.observe({ ...f.event, action: 'completed' })).status, 'completed');
  const entry = f.pool()[f.ownerKey], job = f.job();
  assert.equal(entry.actualJob.state, 'completed');
  assert.deepEqual(JSON.parse(job.actualCompletion), entry.actualJob);
  assert.equal(validatedActualCompletion({ entry, job }), true);
  assert.ok(Object.values(job).every(v => typeof v === 'string' || typeof v === 'boolean'));
});
test('different attempt or actual job persists a sticky conflict and removes terminal eligibility', async () => {
  for (const changes of [{ run_attempt: '2' }, { job_id: '12' }, { run_id: '21' }]) {
    const f = fixture(); await f.association.observe({ ...f.event, action: 'completed' });
    assert.equal((await f.association.observe({ ...f.event, ...changes })).status, 'conflict');
    const entry = f.pool()[f.ownerKey], job = f.job();
    assert.ok(entry.associationConflict); assert.ok(job.associationConflict);
    assert.equal(validatedActualCompletion({ entry, job }), false);
    assert.equal((await f.association.observe({ ...f.event, action: 'completed' })).status, 'conflict');
    assert.equal(job.done, false);
  }
});
test('duplicate issued runner ID or name conflicts every matching owner before any writes', async () => {
  for (const duplicate of ['id', 'name']) {
    const f = fixture(), secondEvent = { ...f.ownerEvent, job_id: '50' }, secondKey = identity(secondEvent).key;
    const second = clone(f.entry);
    second.name = duplicate === 'name' ? f.entry.name : identity(secondEvent).name;
    second.runnerIdentity.name = second.name; second.bootstrap.runnerName = second.name;
    if (duplicate === 'name') { second.runnerIdentity.id = 8; second.bootstrap.runnerId = 8; }
    const pool = f.pool(); pool[secondKey] = second; f.setPool(pool);
    f.documents.set('job_provisioning/' + secondKey, { done: false, state: 'pending', event: JSON.stringify(secondEvent), bootstrap: JSON.stringify(second.bootstrap) });
    assert.equal((await f.association.observe({ ...f.event, action: 'completed' })).status, 'conflict');
    assert.ok(f.pool()[f.ownerKey].associationConflict); assert.ok(f.pool()[secondKey].associationConflict);
    assert.ok(f.documents.get('job_provisioning/' + secondKey).associationConflict);
    assert.equal(f.job().actualCompletion, undefined);
  }
});
test('unmirrored issued receipt or missing owner demand cannot create completion proof', async () => {
  for (const failure of ['mirror', 'missing', 'claim']) {
    const f = fixture(); const job = f.job();
    if (failure === 'missing') f.documents.delete('job_provisioning/' + f.ownerKey);
    else {
      const bootstrap = JSON.parse(job.bootstrap);
      if (failure === 'mirror') bootstrap.runnerId = 8;
      else bootstrap.claimId = '33333333-3333-4333-8333-333333333333';
      job.bootstrap = JSON.stringify(bootstrap); f.documents.set('job_provisioning/' + f.ownerKey, job);
    }
    assert.equal((await f.association.observe({ ...f.event, action: 'completed' })).status, 'conflict');
    assert.ok(f.pool()[f.ownerKey].associationConflict);
  }
});
test('transaction retry after reservation or incarnation replacement preserves new ownership untouched', async () => {
  for (const field of ['token', 'instanceId', 'instanceCreationTimestamp']) {
    const f = fixture(); let changed;
    f.retry(() => { const pool = f.pool();
      pool[f.ownerKey][field] = field === 'token' ? '33333333-3333-4333-8333-333333333333' :
        field === 'instanceId' ? '987654321' : '2026-10-05T11:00:00Z';
      f.setPool(pool); changed = clone(f.documents);
    });
    const result = await f.association.observe({ ...f.event, action: 'completed' });
    assert.equal(result.status, 'preserved'); assert.equal(result.reason, 'ownership_changed');
    assert.deepEqual(f.documents, changed);
  }
});
test('concurrent different dispatches retain the first binding and durable conflict', async () => {
  const f = fixture(); const results = await Promise.all([f.association.observe(f.event),
    f.association.observe({ ...f.event, job_id: '12', action: 'completed' })]);
  assert.deepEqual(results.map(r => r.status), ['associated', 'conflict']);
  assert.equal(f.pool()[f.ownerKey].actualJob.key, identity(f.event).key);
  assert.equal(validatedActualCompletion({ entry: f.pool()[f.ownerKey], job: f.job() }), false);
});
test('the same actual job already attached to another issued allocation cannot be reassigned', async () => {
  const f = fixture(); await f.association.observe(f.event);
  const otherEvent = { ...f.ownerEvent, job_id: '50' }, otherKey = identity(otherEvent).key;
  const second = clone(f.entry); second.name = identity(otherEvent).name;
  second.runnerIdentity = { ...second.runnerIdentity, id: 8, name: second.name };
  second.bootstrap = { ...second.bootstrap, runnerId: 8, runnerName: second.name };
  second.actualJob = clone(f.pool()[f.ownerKey].actualJob);
  const pool = f.pool(); pool[otherKey] = second; f.setPool(pool);
  f.documents.set('job_provisioning/' + otherKey, { done: false, event: JSON.stringify(otherEvent), bootstrap: JSON.stringify(second.bootstrap) });
  assert.equal((await f.association.observe({ ...f.event, action: 'completed' })).status, 'conflict');
  assert.ok(f.pool()[otherKey].associationConflict);
});
test('terminal helper rejects changed ownership, forged mirrors and any durable conflict', async () => {
  const f = fixture(); await f.association.observe({ ...f.event, action: 'completed' });
  const entry = f.pool()[f.ownerKey], job = f.job();
  assert.equal(validatedActualCompletion({ entry, job }), true);
  for (const field of ['reservationToken', 'instanceId', 'instanceCreationTimestamp', 'claimId', 'runnerId', 'key']) {
    const mutated = clone(entry); mutated.actualJob[field] = 'wrong';
    assert.equal(validatedActualCompletion({ entry: mutated, job }), false);
  }
  assert.equal(validatedActualCompletion({ entry, job: { ...job, actualCompletion: '{}' } }), false);
  assert.equal(validatedActualCompletion({ entry: { ...entry, associationConflict: {} }, job }), false);
  assert.equal(validatedActualCompletion({ entry, job: { ...job, associationConflict: '{}' } }), false);
});
test('corrupt pool data or absent issued runner returns preserved without synthesizing demand', async () => {
  const f = fixture(); f.documents.set('provisioning_pools/global', { entries: 'invalid-json' });
  assert.equal((await f.association.observe(f.event)).status, 'preserved');
  const g = fixture(); g.setPool({}); const before = clone(g.documents);
  assert.equal((await g.association.observe(g.event)).status, 'preserved');
  assert.deepEqual(g.documents, before);
});

test('reverse execution pointer survives owner pool retirement and cannot be claimed by another allocation', async () => {
  const f = fixture(); await f.association.observe({ ...f.event, action: 'completed' });
  const actualKey = identity(f.event).key, receipt = clone(f.documents.get('job_provisioning/' + actualKey));
  f.setPool({});
  assert.equal((await f.association.observe({ ...f.event, action: 'completed' })).status, 'preserved');
  assert.deepEqual(f.documents.get('job_provisioning/' + actualKey), receipt);
  const nextEvent = { ...f.ownerEvent, job_id: '90' }, nextKey = identity(nextEvent).key;
  const next = clone(f.entry); next.name = identity(nextEvent).name;
  next.runnerIdentity = { ...next.runnerIdentity, id: 9, name: next.name };
  next.bootstrap = { ...next.bootstrap, runnerId: 9, runnerName: next.name,
    claimId: '33333333-3333-4333-8333-333333333333' };
  next.token = '44444444-4444-4444-8444-444444444444'; next.instanceId = '987654321';
  f.setPool({ [nextKey]: next });
  f.documents.set('job_provisioning/' + nextKey, { done: false, state: 'pending',
    event: JSON.stringify(nextEvent), bootstrap: JSON.stringify(next.bootstrap) });
  assert.equal((await f.association.observe({ ...f.event, runner_id: 9, runner_name: next.name })).status, 'conflict');
  assert.ok(f.pool()[nextKey].associationConflict);
  assert.deepEqual(f.documents.get('job_provisioning/' + actualKey), receipt);
});
test('B demand executed by A is independent of B own allocation executing C', async () => {
  const f = fixture(); const bEvent = { ...f.ownerEvent, job_id: '11' }, bKey = identity(bEvent).key;
  const b = clone(f.entry); b.name = identity(bEvent).name;
  b.runnerIdentity = { ...b.runnerIdentity, id: 8, name: b.name };
  b.bootstrap = { ...b.bootstrap, runnerId: 8, runnerName: b.name,
    claimId: '33333333-3333-4333-8333-333333333333' };
  b.token = '44444444-4444-4444-8444-444444444444'; b.instanceId = '987654321';
  const pool = f.pool(); pool[bKey] = b; f.setPool(pool);
  f.documents.set('job_provisioning/' + bKey, { done: false, state: 'pending', event: JSON.stringify(bEvent), bootstrap: JSON.stringify(b.bootstrap) });
  const cEvent = { ...f.event, job_id: '12', runner_id: 8, runner_name: b.name };
  assert.equal((await f.association.observe(cEvent)).status, 'associated');
  const bBefore = clone(f.documents.get('job_provisioning/' + bKey));
  assert.equal((await f.association.observe(f.event)).status, 'associated');
  const bAfter = f.documents.get('job_provisioning/' + bKey);
  assert.equal(bAfter.actualJob, bBefore.actualJob);
  assert.equal(JSON.parse(bAfter.actualJob).key, identity(cEvent).key);
  assert.equal(JSON.parse(bAfter.executedBy).allocationKey, f.ownerKey);
  assert.equal(bAfter.done, false); assert.equal(f.job().done, false);
  assert.equal((await f.association.observe({ ...f.event, action: 'completed' })).status, 'completed');
  assert.equal(f.documents.get('job_provisioning/' + bKey).actualJob, bBefore.actualJob);
  assert.equal(JSON.parse(f.documents.get('job_provisioning/' + bKey).executedBy).state, 'completed');
});
test('same-key demand and owner execution receipts merge in one document without overwriting each other', async () => {
  const f = fixture(); const event = { ...f.event, job_id: f.ownerEvent.job_id, action: 'completed' };
  assert.equal((await f.association.observe(event)).status, 'completed');
  const job = f.job(), actual = JSON.parse(job.actualJob), reverse = JSON.parse(job.executedBy);
  assert.equal(reverse.allocationKey, f.ownerKey); assert.equal(reverse.actualJobKey, f.ownerKey);
  assert.equal(actual.key, f.ownerKey); assert.equal(reverse.state, 'completed');
  assert.equal(job.done, false); assert.equal(validatedActualCompletion({ entry: f.pool()[f.ownerKey], job }), true);
  assert.equal((await f.association.observe({ ...event, action: 'in_progress' })).status, 'duplicate');
});
test('corrupt or changed reverse ownership is sticky rather than overwritten', async () => {
  for (const failure of ['invalid', 'token', 'claim', 'incarnation']) {
    const f = fixture(); await f.association.observe(f.event);
    const actualKey = identity(f.event).key, demand = clone(f.documents.get('job_provisioning/' + actualKey));
    if (failure === 'invalid') demand.executedBy = 'invalid-json';
    else { const pointer = JSON.parse(demand.executedBy);
      pointer[failure === 'token' ? 'reservationToken' : failure === 'claim' ? 'claimId' : 'instanceCreationTimestamp'] = 'changed';
      demand.executedBy = JSON.stringify(pointer); }
    f.documents.set('job_provisioning/' + actualKey, demand);
    assert.equal((await f.association.observe({ ...f.event, action: 'completed' })).status, 'conflict');
    assert.ok(f.pool()[f.ownerKey].associationConflict);
    assert.equal(f.documents.get('job_provisioning/' + actualKey).executedBy, demand.executedBy);
    assert.equal(validatedActualCompletion({ entry: f.pool()[f.ownerKey], job: f.job() }), false);
  }
});
test('late signed completion of an issued orphaned incarnation records audit without capacity or claim reset', async () => {
  const f = fixture(); await f.association.observe(f.event);
  const pool = f.pool(); pool[f.ownerKey].state = 'orphaned'; f.setPool(pool);
  assert.equal((await f.association.observe({ ...f.event, action: 'completed' })).status, 'completed');
  const entry = f.pool()[f.ownerKey];
  assert.equal(entry.state, 'orphaned'); assert.equal(entry.bootstrap.state, 'issued');
  assert.equal(entry.token, f.entry.token); assert.equal(f.job().done, false);
  assert.equal(validatedActualCompletion({ entry, job: f.job() }), true);
});
