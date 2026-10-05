'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createLifecycleDispatcher} = require('../cloud-functions/cleanup-function/lifecycle-dispatcher');
const {knownReceipt, binding} = require('../cloud-functions/cleanup-function/allocation-lifecycle');
const {identity} = require('../cloud-functions/webhook-handler/job-identity');
function fixture(options = {}) {
  const event = {repo_owner: 'example-owner', repo_name: 'example-repository', run_id: '10', job_id: '20', run_attempt: '1'};
  const {key, name} = identity(event), labels = ['self-hosted', 'private-one-job'];
  const token = '11111111-1111-4111-8111-111111111111', claimId = '22222222-2222-4222-8222-222222222222';
  const bootstrap = {version: 1, state: 'issued', claimId, runnerId: 77, runnerName: name, runnerLabels: labels};
  const entry = {state: 'retiring', token, name, zone: 'zone-a', project: 'example-project', instanceId: '12345',
    instanceCreationTimestamp: '2000-01-01T00:00:00Z', bootstrap, runnerIdentity: {id: 77, name, labels}, demandDone: true};
  const completion = {verifiedWebhook: true, runnerId: '77', runnerName: name, repositoryOwner: event.repo_owner,
    repositoryName: event.repo_name, jobId: '20', runId: '10', runAttempt: '1'};
  const job = {done: true, event: JSON.stringify(event), bootstrap: JSON.stringify(bootstrap), completion: JSON.stringify(completion)};
  const bound = binding(key, entry, knownReceipt({entry, job}));
  entry.lifecycle = {drain: {version: 1, state: 'requested', binding: bound, actualCompletion: job.completion,
    observedVmStatus: 'RUNNING', observedAtMs: 10, sideEffectsEnabled: false}};
  job.lifecycle = JSON.stringify(entry.lifecycle);
  const pool = {entries: JSON.stringify({[key]: entry}), unrelated: 'preserved'}, calls = [];
  const getEntry = () => JSON.parse(pool.entries)[key];
  const setEntry = e => {pool.entries = JSON.stringify({[key]: e});};
  const firestore = {doc: path => ({path}), runTransaction: async fn => fn({
    get: async ref => ({data: () => structuredClone(ref.path.startsWith('provisioning_pools/') ? pool : job)}),
    set: (ref, value) => Object.assign(ref.path.startsWith('provisioning_pools/') ? pool : job, structuredClone(value))})};
  const vm = {id: entry.instanceId, name, creationTimestamp: entry.instanceCreationTimestamp, status: 'RUNNING',
    zone: 'https://www.googleapis.com/compute/v1/projects/example-project/zones/zone-a',
    selfLink: `https://www.googleapis.com/compute/v1/projects/example-project/zones/zone-a/instances/${name}`,
    labels: {purpose: 'github-runner'},
    metadata: {items: [{key: 'allocation-key', value: key}, {key: 'reservation-token', value: token}]}};
  let rows = [{id: 77, name, busy: false, labels: labels.map(name => ({name}))}];
  const compute = {get: async () => {calls.push('compute.get'); return [structuredClone(vm)];},
    stop: () => {throw Error('forbidden');}, delete: () => {throw Error('forbidden');}};
  const runnerAdapter = {listRunnerPage: async () => {calls.push('runner.list'); return {total_count: rows.length, runners: structuredClone(rows)};},
    inspectOwnedRunner: async () => {calls.push('runner.inspect'); return {status: 'present', busy: false};}};
  const ack = command => ({...command, authenticated: true, incarnationFenced: true,
    state: command.phase === 'drain' ? 'drained' : 'stopped'});
  const workerControl = {requestDrain: async command => {calls.push('worker.drain'); return ack(command);},
    requestStop: async command => {calls.push('worker.stop'); return ack(command);},
    inspectOperation: async command => {calls.push('worker.inspect'); return ack(command);}};
  const config = {firestore, compute, runnerAdapter, workerControl, repositoryOwner: event.repo_owner,
    repositoryName: event.repo_name, projectId: entry.project, dispatchEnabled: true, approvedQuiescence: true,
    workerDrainQualified: true, workerStopQualified: true, clock: () => 100,
    newDispatchId: () => '33333333-3333-4333-8333-333333333333', ...options};
  const dispatcher = createLifecycleDispatcher(config);
  const request = {key, token, name, zone: entry.zone, project: entry.project, instanceId: entry.instanceId,
    instanceCreationTimestamp: entry.instanceCreationTimestamp, claimId, phase: 'drain'};
  return {dispatcher, request, calls, pool, job, getEntry, setEntry, compute, runnerAdapter, workerControl, vm, ack,
    rows: () => rows, setRows: next => {rows = next;}, config};
}
test('large decimal VM identity stays exact through lifecycle binding and acknowledged dispatch', async () => {
  const f = fixture(), instanceId = '9223372036854775807';
  const entry = f.getEntry(); entry.instanceId = instanceId; entry.lifecycle.drain.binding.instanceId = instanceId;
  f.setEntry(entry); f.job.lifecycle = JSON.stringify(entry.lifecycle); f.vm.id = instanceId;
  assert.equal((await f.dispatcher.dispatchIntent({...f.request, instanceId})).status, 'acknowledged');
  assert.equal(f.getEntry().lifecycle.drain.dispatch.binding.instanceId, instanceId);
});
test('default qualification gates deny before any provider read', async () => {
  for (const flag of ['dispatchEnabled', 'approvedQuiescence', 'workerDrainQualified']) {
    const f = fixture({[flag]: false}); assert.equal((await f.dispatcher.dispatchIntent(f.request)).reason, 'dispatch_not_qualified');
    assert.deepEqual(f.calls, []); assert.equal(f.getEntry().lifecycle.drain.dispatch, undefined);
  }
});
test('durable mirrored consumed operation precedes effect and acknowledgement retains capacity', async () => {
  const f = fixture(); f.workerControl.requestDrain = async command => {
    assert.equal(f.getEntry().lifecycle.drain.dispatch.state, 'consumed');
    assert.deepEqual(f.getEntry().lifecycle, JSON.parse(f.job.lifecycle)); return f.ack(command);
  };
  assert.equal((await f.dispatcher.dispatchIntent(f.request)).status, 'acknowledged');
  assert.equal(f.getEntry().state, 'retiring'); assert.equal(f.pool.unrelated, 'preserved');
  assert.equal(f.getEntry().lifecycle.drain.dispatch.state, 'acknowledged');
});
test('acknowledged replay cannot send another operation', async () => {
  const f = fixture(); await f.dispatcher.dispatchIntent(f.request); await f.dispatcher.dispatchIntent(f.request);
  assert.equal(f.calls.filter(x => x === 'worker.drain').length, 1);
});
test('timeout consumes dispatch; recovery uses operation readback without resend', async () => {
  const f = fixture(); f.workerControl.requestDrain = async () => {f.calls.push('worker.drain'); throw Error('private error omitted');};
  assert.equal((await f.dispatcher.dispatchIntent(f.request)).reason, 'dispatch_outcome_uncertain');
  assert.equal(f.getEntry().lifecycle.drain.dispatch.state, 'uncertain');
  assert.equal((await f.dispatcher.dispatchIntent(f.request)).status, 'acknowledged');
  assert.equal(f.calls.filter(x => x === 'worker.drain').length, 1); assert.ok(f.calls.includes('worker.inspect'));
});
test('unknown operation readback never reissues and keeps charged entry', async () => {
  const f = fixture(); f.workerControl.requestDrain = async () => null; f.workerControl.inspectOperation = async () => ({state: 'not_started'});
  await f.dispatcher.dispatchIntent(f.request);
  assert.equal((await f.dispatcher.dispatchIntent(f.request)).reason, 'dispatch_outcome_uncertain'); assert.ok(f.getEntry());
});
test('wrong correlation, unauthenticated or unfenced acknowledgement cannot qualify', async () => {
  for (const change of [{dispatchId: '44444444-4444-4444-8444-444444444444'}, {authenticated: false},
    {incarnationFenced: false}, {state: 'idle'}, {binding: {instanceId: 'replacement'}}]) {
    const f = fixture(); f.workerControl.requestDrain = async command => ({...f.ack(command), ...change});
    assert.equal((await f.dispatcher.dispatchIntent(f.request)).reason, 'dispatch_outcome_uncertain');
    assert.notEqual(f.getEntry().lifecycle.drain.dispatch.state, 'acknowledged');
  }
});
test('busy, extra labels, duplicate labels or near-prefix ambiguity preserve before send', async () => {
  for (const mutate of [rows => {rows[0].busy = true;}, rows => {rows[0].labels.push({name: 'changed'});},
    rows => {rows[0].labels[1] = rows[0].labels[0];}, rows => {rows.push({...rows[0], id: 78, name: rows[0].name + '-other'}); }]) {
    const f = fixture(); const rows = f.rows(); mutate(rows); f.setRows(rows);
    assert.equal((await f.dispatcher.dispatchIntent(f.request)).status, 'preserved'); assert.ok(!f.calls.includes('worker.drain'));
  }
});
test('unknown/replaced/starting incarnation cannot dispatch', async () => {
  for (const change of [{id: '999'}, {creationTimestamp: '2001-01-01T00:00:00Z'}, {status: 'STAGING'}]) {
    const f = fixture(); Object.assign(f.vm, change); await f.dispatcher.dispatchIntent(f.request);
    assert.ok(!f.calls.includes('worker.drain'));
  }
});
test('ownership mutation during provider observation fails final reservation CAS', async () => {
  const f = fixture(); const inspect = f.runnerAdapter.inspectOwnedRunner;
  f.runnerAdapter.inspectOwnedRunner = async () => {const e = f.getEntry(); e.token = '44444444-4444-4444-8444-444444444444'; f.setEntry(e); return inspect();};
  assert.equal((await f.dispatcher.dispatchIntent(f.request)).reason, 'dispatch_evidence_changed');
  assert.ok(!f.calls.includes('worker.drain')); assert.equal(f.getEntry().lifecycle.drain.dispatch, undefined);
});
test('completion mutation during provider read preserves before effect', async () => {
  const f = fixture(); f.runnerAdapter.inspectOwnedRunner = async () => {delete f.job.completion; return {status: 'present', busy: false};};
  await f.dispatcher.dispatchIntent(f.request); assert.ok(!f.calls.includes('worker.drain'));
});
test('mirror corruption and sticky association conflict deny', async () => {
  for (const change of [f => {f.job.lifecycle = '{}';}, f => {f.job.associationConflict = '{"reason":"conflict"}';}]) {
    const f = fixture(); change(f); await f.dispatcher.dispatchIntent(f.request); assert.deepEqual(f.calls, []);
  }
});
test('stop requires acknowledged same-binding drain and separate stop qualification', async () => {
  const f = fixture(); const e = f.getEntry(); e.lifecycle.stop = structuredClone(e.lifecycle.drain);
  f.setEntry(e); f.job.lifecycle = JSON.stringify(e.lifecycle);
  const stop = {...f.request, phase: 'stop'};
  await f.dispatcher.dispatchIntent(stop); assert.ok(!f.calls.includes('worker.stop'));
  await f.dispatcher.dispatchIntent(f.request);
  assert.equal((await f.dispatcher.dispatchIntent(stop)).status, 'acknowledged');
  assert.equal(f.calls.filter(x => x === 'worker.stop').length, 1);
});
test('inspect absent attempt performs no effect or provider read', async () => {
  const f = fixture(); assert.equal((await f.dispatcher.inspectDispatch(f.request)).reason, 'dispatch_not_started');
  assert.deepEqual(f.calls, []);
});
test('caller cannot supply qualification or provider options', async () => {
  const f = fixture(); await f.dispatcher.dispatchIntent({...f.request, approvedQuiescence: true}); assert.deepEqual(f.calls, []);
});
test('provider error never exposes raw exception or consumes an unsent attempt', async () => {
  const f = fixture(); f.compute.get = async () => {throw Error('private provider detail');};
  const result = await f.dispatcher.dispatchIntent(f.request);
  assert.equal(result.reason, 'dispatch_outcome_uncertain'); assert.ok(!JSON.stringify(result).includes('private'));
  assert.equal(f.getEntry().lifecycle.drain.dispatch, undefined);
});
test('consumed effect can recover by scoped readback after VM/registration loss', async () => {
  const f = fixture(); f.workerControl.requestDrain = async () => null;
  await f.dispatcher.dispatchIntent(f.request);
  f.compute.get = async () => {throw Error('must not read lost VM for operation readback');};
  f.setRows([]);
  assert.equal((await f.dispatcher.inspectDispatch(f.request)).status, 'acknowledged');
  assert.ok(f.getEntry()); assert.equal(f.getEntry().state, 'retiring');
});
test('Compute zone and selfLink must identify exact project scope', async () => {
  for (const change of [{zone: 'https://www.googleapis.com/compute/v1/projects/another/zones/zone-a'},
    {selfLink: 'https://www.googleapis.com/compute/v1/projects/another/zones/zone-a/instances/other'}]) {
    const f = fixture(); Object.assign(f.vm, change); await f.dispatcher.dispatchIntent(f.request);
    assert.ok(!f.calls.includes('worker.drain'));
  }
});
test('Firestore retry cannot transfer a dispatch to changed ownership', async () => {
  const f = fixture(), original = f.config.firestore.runTransaction; let count = 0;
  f.config.firestore.runTransaction = async callback => {
    if (++count === 2) {
      await original(tx => callback({...tx, set: () => {}}));
      const e = f.getEntry(); e.instanceId = '67890'; f.setEntry(e);
    }
    return original(callback);
  };
  await f.dispatcher.dispatchIntent(f.request);
  assert.ok(!f.calls.includes('worker.drain')); assert.equal(f.getEntry().lifecycle.drain.dispatch, undefined);
});
test('invalid start clock cannot persist an attempt', async () => {
  for (const clock of [() => -1, () => NaN, () => '100']) {
    const f = fixture({clock}); await f.dispatcher.dispatchIntent(f.request);
    assert.equal(f.getEntry().lifecycle.drain.dispatch, undefined); assert.ok(!f.calls.includes('worker.drain'));
  }
});
test('invalid acknowledgement clock preserves consumed attempt without releasing capacity', async () => {
  for (const invalidClock of [-1, 99]) {
    let tick = 0; const f = fixture({clock: () => ++tick === 1 ? 100 : invalidClock});
    assert.equal((await f.dispatcher.dispatchIntent(f.request)).status, 'preserved');
    assert.equal(f.getEntry().lifecycle.drain.dispatch.state, 'consumed'); assert.ok(f.getEntry());
  }
});
test('different actual signed job permits dispatch without completing reserved demand', async () => {
  const f = fixture(), e = f.getEntry(), owner = JSON.parse(f.job.event);
  const actualEvent = {...owner, job_id: '21'};
  const actual = {version: 1, key: identity(actualEvent).key, repositoryOwner: owner.repo_owner,
    repositoryName: owner.repo_name, runId: '10', jobId: '21', runAttempt: '1', runnerId: '77',
    runnerName: e.name, claimId: e.bootstrap.claimId, reservationToken: e.token,
    instanceId: e.instanceId, instanceCreationTimestamp: e.instanceCreationTimestamp,
    state: 'completed', verifiedWebhook: true, observedAtMs: 10};
  e.actualJob = actual; e.demandDone = false; f.job.done = false;
  f.job.actualJob = JSON.stringify(actual); f.job.actualCompletion = JSON.stringify(actual);
  e.lifecycle.drain.actualCompletion = f.job.actualCompletion; f.setEntry(e); f.job.lifecycle = JSON.stringify(e.lifecycle);
  assert.equal((await f.dispatcher.dispatchIntent(f.request)).status, 'acknowledged');
  assert.equal(f.job.done, false); assert.equal(f.getEntry().demandDone, false); assert.ok(f.getEntry());
});
test('replay completion revocation denies operation readback', async () => {
  const f = fixture(); f.workerControl.requestDrain = async () => null; await f.dispatcher.dispatchIntent(f.request);
  delete f.job.completion; const before = f.calls.length;
  assert.equal((await f.dispatcher.inspectDispatch(f.request)).status, 'preserved');
  assert.equal(f.calls.length, before); assert.ok(f.getEntry());
});
test('malformed or corrupted prior drain operation can never authorize stop', async () => {
  const corruptions = [record => {record.dispatchId = null; record.acknowledgement.dispatchId = null;},
    record => {delete record.dispatchId; delete record.acknowledgement.dispatchId;},
    record => {record.evidenceSha256 = null; record.acknowledgement.evidenceSha256 = null;},
    record => {record.evidenceSha256 = '0'.repeat(64); record.acknowledgement.evidenceSha256 = record.evidenceSha256;},
    record => {record.startedAtMs = '100';}, record => {record.startedAtMs = -1;},
    record => {record.observedAtMs = 99;}, record => {record.phase = 'stop'; record.acknowledgement.phase = 'stop';},
    record => {record.acknowledgement.authenticated = false;}, record => {record.binding.instanceId = '67890';},
    record => {delete record.acknowledgement;}, record => {record.state = 'consumed';}];
  for (const corrupt of corruptions) {
    const f = fixture(); await f.dispatcher.dispatchIntent(f.request);
    const e = f.getEntry(); corrupt(e.lifecycle.drain.dispatch);
    e.lifecycle.stop = {...structuredClone(e.lifecycle.drain), dispatch: undefined};
    f.setEntry(e); f.job.lifecycle = JSON.stringify(e.lifecycle);
    const before = f.calls.length;
    assert.equal((await f.dispatcher.dispatchIntent({...f.request, phase: 'stop'})).status, 'preserved');
    assert.ok(!f.calls.includes('worker.stop')); assert.equal(f.calls.length, before);
  }
});
