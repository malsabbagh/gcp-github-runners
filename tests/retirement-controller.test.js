'use strict';
// Built-in runner only. Root composes the four pure modules before execution.
const test = require('node:test');
const assert = require('node:assert/strict');
const {identity} = require('../cloud-functions/webhook-handler/job-identity');
const {createRetirementController} = require('../cloud-functions/cleanup-function/retirement-controller');
const {terminalProof} = require('../cloud-functions/cleanup-function/allocation-lifecycle');
function fixture({vmStatus = 'TERMINATED', absent = false, approvedQuiescence = false,
                  busy = false, archived = false} = {}) {
  const ownerEvent = {repo_owner: 'example-owner', repo_name: 'example-repository', run_id: '10', job_id: '20', run_attempt: '1'};
  const actualEvent = {...ownerEvent, job_id: '21'};
  const {key, name} = identity(ownerEvent), actualKey = identity(actualEvent).key;
  const token = '11111111-1111-4111-8111-111111111111';
  const claimId = '22222222-2222-4222-8222-222222222222';
  const labels = ['self-hosted', 'private-one-job'];
  const bootstrap = {version: 1, state: 'issued', claimId, runnerId: 77, runnerName: name, runnerLabels: labels};
  const actual = {version: 1, key: actualKey, repositoryOwner: ownerEvent.repo_owner, repositoryName: ownerEvent.repo_name,
    runId: '10', jobId: '21', runAttempt: '1', runnerId: '77', runnerName: name, claimId,
    reservationToken: token, instanceId: '12345', instanceCreationTimestamp: '2000-01-01T00:00:00Z',
    state: 'completed', verifiedWebhook: true, observedAtMs: 100};
  const entry = {name, token, zone: 'zone-a', project: 'example-project', instanceId: '12345',
    instanceCreationTimestamp: actual.instanceCreationTimestamp, state: 'active', demandDone: false, bootstrap,
    runnerIdentity: {id: 77, name, labels}, actualJob: actual};
  const job = {done: false, event: JSON.stringify(ownerEvent), bootstrap: JSON.stringify(bootstrap),
    actualJob: JSON.stringify(actual), actualCompletion: JSON.stringify(actual)};
  const pool = {entries: JSON.stringify(archived ? {} : {[key]: entry}), preservedField: 'unchanged'};
  if (archived) {
    job.pendingCleanup = JSON.stringify([{allocation: structuredClone(entry), archivedAtMs: 100}]);
    job.bootstrapHistory = JSON.stringify([{instanceId: entry.instanceId, instanceCreationTimestamp: entry.instanceCreationTimestamp,
      reservationToken: token, bootstrap: structuredClone(bootstrap), archivedAtMs: 100}]);
    delete job.bootstrap;
  }
  const calls = [];
  const firestore = {doc: name => ({name}), runTransaction: async body => body({
    get: async ref => ({exists: true, data: () => structuredClone(ref.name.startsWith('provisioning_pools/') ? pool : job)}),
    set: (ref, data, options) => {
      const target = ref.name.startsWith('provisioning_pools/') ? pool : job;
      if (!options?.merge) Object.keys(target).forEach(k => delete target[k]);
      Object.assign(target, structuredClone(data));
    }})};
  let vm = absent ? undefined : {id: entry.instanceId, name, status: vmStatus,
    creationTimestamp: entry.instanceCreationTimestamp, zone: 'projects/example-project/zones/zone-a',
    labels: {purpose: 'github-runner'}, metadata: {items: [{key: 'allocation-key', value: key}, {key: 'reservation-token', value: token}]}};
  let runners = [{id: 77, name, busy, labels: labels.map(name => ({name}))}];
  const compute = {get: async () => {calls.push('compute.get'); if (!vm) throw {code: 5}; return [structuredClone(vm)];},
    delete: async () => {calls.push('compute.delete'); vm = undefined;}, stop: async () => {throw Error('stop must never execute');}};
  const runnerAdapter = {listRunnerPage: async ({page, perPage}) => {
    calls.push('runner.list'); return {total_count: runners.length, runners: structuredClone(runners.slice((page - 1) * perPage, page * perPage))};
  }, inspectOwnedRunner: async () => {
    calls.push('runner.inspect'); const row = runners.find(r => r.id === 77);
    return row ? {status: 'present', busy: row.busy} : {status: 'absent'};
  }, deregisterOwnedRunner: async () => {calls.push('runner.delete'); runners = []; return {status: 'absent'};}};
  const controller = createRetirementController({firestore, compute, runnerAdapter, projectId: entry.project,
    repositoryOwner: ownerEvent.repo_owner, repositoryName: ownerEvent.repo_name, approvedQuiescence});
  const request = {key, name, token, zone: entry.zone, project: entry.project, instanceId: entry.instanceId,
    instanceCreationTimestamp: entry.instanceCreationTimestamp, claimId};
  return {key, name, entry, job, pool, compute, runnerAdapter, controller, request, calls,
    poolEntry: () => JSON.parse(pool.entries)[key], setPoolEntry: value => {pool.entries = JSON.stringify({[key]: value});},
    setRunners: value => {runners = value;}, changeVm: update => {vm = {...vm, ...update};}};
}
test('supplied wrong claim cannot drain stop retire or reconcile before provider observations', async () => {
  const f = fixture({approvedQuiescence: true});
  const request = {...f.request, claimId: '99999999-9999-4999-8999-999999999999'};
  for (const method of ['requestDrain', 'prepareStop', 'retireAllocation', 'reconcileOrphan'])
    assert.equal((await f.controller[method](request)).status, 'preserved');
  assert.deepEqual(f.calls, []); assert.ok(f.poolEntry()); assert.equal(f.job.lifecycle, undefined);
});
test('large decimal VM identifiers retain exact incarnation proof without numeric conversion', async () => {
  const f = fixture({approvedQuiescence: true}), instanceId = '9223372036854775807';
  const entry = f.poolEntry(); entry.instanceId = instanceId; entry.actualJob.instanceId = instanceId;
  f.setPoolEntry(entry); f.job.actualJob = JSON.stringify(entry.actualJob); f.job.actualCompletion = f.job.actualJob;
  f.changeVm({id: instanceId}); const request = {...f.request, instanceId};
  assert.equal((await f.controller.requestDrain(request)).status, 'intent_recorded');
  assert.equal((await f.controller.retireAllocation(request)).status, 'retired');
  assert.equal(f.job.done, false); assert.equal(JSON.parse(f.job.cleanup).instanceId, instanceId);
});
test('different actual signed job retires without completing original reserved demand', async () => {
  const f = fixture({approvedQuiescence: true});
  assert.equal((await f.controller.retireAllocation(f.request)).status, 'retired');
  assert.equal(f.job.done, false); assert.equal(f.poolEntry(), undefined);
  assert.equal(JSON.parse(f.job.cleanup).allocation.actualJob.jobId, '21');
  assert.equal(f.pool.preservedField, 'unchanged');
});
test('drain and stop preparation record mirrored intents, never Compute stop/delete', async () => {
  const f = fixture({vmStatus: 'RUNNING'});
  assert.equal((await f.controller.prepareStop(f.request)).status, 'preserved');
  assert.equal((await f.controller.requestDrain(f.request)).status, 'intent_recorded');
  assert.equal((await f.controller.prepareStop(f.request)).status, 'intent_recorded');
  assert.deepEqual(f.poolEntry().lifecycle, JSON.parse(f.job.lifecycle));
  assert.equal(f.poolEntry().lifecycle.stop.sideEffectsEnabled, false);
  assert.ok(!f.calls.includes('compute.delete')); assert.ok(!f.calls.includes('runner.delete'));
});
test('busy actual runner cannot drain', async () => {
  const f = fixture({vmStatus: 'RUNNING', busy: true});
  assert.equal((await f.controller.requestDrain(f.request)).status, 'preserved');
  assert.equal(f.job.lifecycle, undefined);
});
test('running/unknown VM cannot be retired by signed completion alone', async () => {
  for (const vmStatus of ['RUNNING', 'STAGING', 'UNKNOWN']) {
    const f = fixture({vmStatus, approvedQuiescence: true});
    assert.equal((await f.controller.retireAllocation(f.request)).status, 'preserved');
    assert.ok(!f.calls.includes('runner.delete')); assert.ok(f.poolEntry());
  }
});
test('idle and original demand done cannot replace actual signed completion', async () => {
  const f = fixture(); f.job.done = true; const entry = f.poolEntry(); entry.demandDone = true;
  entry.actualJob.state = 'running'; f.setPoolEntry(entry); f.job.actualJob = JSON.stringify(entry.actualJob);
  delete f.job.actualCompletion;
  assert.equal((await f.controller.requestDrain(f.request)).status, 'preserved');
});
test('completion reorder/mirror mismatch and sticky conflict preserve', async () => {
  const f = fixture(); const proof = JSON.parse(f.job.actualCompletion); proof.claimId = 'other';
  f.job.actualCompletion = JSON.stringify(proof);
  assert.equal((await f.controller.retireAllocation(f.request)).status, 'preserved');
  f.job.actualCompletion = f.job.actualJob; f.job.associationConflict = JSON.stringify({reason: 'conflict'});
  assert.equal((await f.controller.requestDrain(f.request)).status, 'preserved');
});
test('ownership mutation during inspection cannot fence or delete', async () => {
  const f = fixture({vmStatus: 'RUNNING'}); const get = f.compute.get;
  f.compute.get = async () => {const answer = await get(); const changed = f.poolEntry(); changed.token = '33333333-3333-4333-8333-333333333333'; f.setPoolEntry(changed); return answer;};
  assert.equal((await f.controller.requestDrain(f.request)).status, 'preserved'); assert.equal(f.job.lifecycle, undefined);
});
test('default quiescence prohibits present orphan deregistration and keeps charged receipt', async () => {
  const f = fixture({absent: true});
  assert.equal((await f.controller.reconcileOrphan(f.request)).status, 'preserved');
  assert.equal(f.poolEntry().state, 'orphaned'); assert.ok(!f.calls.includes('runner.delete'));
  assert.equal(JSON.parse(f.job.cleanup).runnerAbsent, false);
});
test('known absent runner+VM orphan closes live slot without changing original completion', async () => {
  const f = fixture({absent: true}); f.setRunners([]);
  assert.deepEqual(await f.controller.reconcileOrphan(f.request), {status: 'orphan_reconciled', accountingGap: false});
  assert.equal(f.poolEntry(), undefined); assert.equal(f.job.done, false); assert.ok(!f.calls.includes('runner.delete'));
});
test('busy orphan stays charged even when Compute is absent', async () => {
  const f = fixture({absent: true, busy: true, approvedQuiescence: true});
  assert.equal((await f.controller.reconcileOrphan(f.request)).status, 'preserved');
  assert.ok(f.poolEntry()); assert.ok(!f.calls.includes('runner.delete'));
});
test('provider absence ambiguity never frees a receipt', async () => {
  const f = fixture({absent: true}); f.compute.get = async () => {throw {code: 404};};
  assert.equal((await f.controller.reconcileOrphan(f.request)).status, 'preserved'); assert.ok(f.poolEntry());
});
test('new/replaced incarnation or changed claim cannot reconcile orphan', async () => {
  const f = fixture(); f.changeVm({id: '67890'});
  assert.equal((await f.controller.reconcileOrphan(f.request)).status, 'preserved');
  f.request.claimId = 'different'; assert.equal((await f.controller.reconcileOrphan(f.request)).status, 'preserved');
});
test('unknown minted ID and missing historical labels never guess a runner', async () => {
  for (const field of ['runnerId', 'runnerLabels']) {
    const f = fixture({absent: true}); const entry = f.poolEntry(); delete entry.bootstrap[field];
    f.setPoolEntry(entry); f.job.bootstrap = JSON.stringify(entry.bootstrap);
    assert.equal((await f.controller.reconcileOrphan(f.request)).status, 'preserved'); assert.ok(!f.calls.includes('runner.inspect'));
  }
});
test('known claimed mint can reconcile only exact mirrored labels/claim after VM loss', async () => {
  const f = fixture({absent: true}); const entry = f.poolEntry(); entry.bootstrap.state = 'claimed'; entry.bootstrap.mintOutcome = 'observed';
  delete entry.runnerIdentity; delete entry.actualJob; delete f.job.actualJob; delete f.job.actualCompletion; f.setPoolEntry(entry); f.job.bootstrap = JSON.stringify(entry.bootstrap); f.setRunners([]);
  assert.equal((await f.controller.reconcileOrphan(f.request)).status, 'orphan_reconciled');
});
test('changed actual runner labels never qualify orphan deletion', async () => {
  const f = fixture({absent: true, approvedQuiescence: true});
  f.setRunners([{id: 77, name: f.name, busy: false, labels: [{name: 'different'}]}]);
  assert.equal((await f.controller.reconcileOrphan(f.request)).status, 'preserved'); assert.ok(!f.calls.includes('runner.delete'));
});
test('retry after deregistration uncertainty does not repeat deletion or reset claim', async () => {
  const f = fixture({absent: true, approvedQuiescence: true}); const list = f.runnerAdapter.listRunnerPage; let fail = true;
  f.runnerAdapter.listRunnerPage = async args => {if (fail && f.calls.includes('runner.delete')) {fail = false; throw Error('opaque');} return list(args);};
  assert.equal((await f.controller.reconcileOrphan(f.request)).status, 'preserved'); assert.ok(f.poolEntry());
  assert.equal((await f.controller.reconcileOrphan(f.request)).status, 'orphan_reconciled');
  assert.equal(f.calls.filter(x => x === 'runner.delete').length, 1);
});
test('archived exact-bound orphan reports preexisting accounting gap', async () => {
  const f = fixture({absent: true, archived: true}); f.setRunners([]);
  assert.deepEqual(await f.controller.reconcileOrphan(f.request),
    {status: 'orphan_reconciled', accountingGap: true, capacityAlreadyReleased: true});
  assert.equal(JSON.parse(f.job.pendingCleanup)[0].cleanup.accountingGap, true);
});
test('archive receipt mismatch or replacement live allocation preserves', async () => {
  const f = fixture({absent: true, archived: true}); const history = JSON.parse(f.job.bootstrapHistory); history[0].reservationToken = 'wrong';
  f.job.bootstrapHistory = JSON.stringify(history);
  assert.equal((await f.controller.reconcileOrphan(f.request)).status, 'preserved');
});
test('strict legacy exact reserved receipt/job completion compatibility', () => {
  const f = fixture(); const entry = f.poolEntry(); delete entry.actualJob; entry.demandDone = true; f.job.done = true;
  delete f.job.actualJob; delete f.job.actualCompletion;
  f.job.completion = JSON.stringify({verifiedWebhook: true, runnerId: '77', runnerName: f.name,
    repositoryOwner: 'example-owner', repositoryName: 'example-repository', jobId: '20', runId: '10', runAttempt: '1'});
  assert.equal(terminalProof({key: f.key, entry, job: f.job}, 'example-owner', 'example-repository'), true);
  const changed = JSON.parse(f.job.completion); changed.jobId = '21'; f.job.completion = JSON.stringify(changed);
  assert.equal(terminalProof({key: f.key, entry, job: f.job}, 'example-owner', 'example-repository'), false);
});

test('running actual job remains charged after VM loss even with quiescence', async () => {
  const f = fixture({absent: true, approvedQuiescence: true}); const entry = f.poolEntry(); entry.actualJob.state = 'running'; f.setPoolEntry(entry); f.job.actualJob = JSON.stringify(entry.actualJob); delete f.job.actualCompletion; f.setRunners([]);
  assert.equal((await f.controller.reconcileOrphan(f.request)).status, 'preserved'); assert.ok(f.poolEntry());
});
test('original demand executing elsewhere stays associated after own VM retirement', async () => {
  const f = fixture({approvedQuiescence: true}); f.job.executedBy = JSON.stringify({state: 'running'});
  assert.equal((await f.controller.retireAllocation(f.request)).status, 'retired'); assert.equal(f.job.state, 'associated'); assert.equal(f.job.done, false);
});

test('unapproved retirement never invokes GitHub deregistration for a present exact runner', async () => {
  for (const absent of [false, true]) {
    const f = fixture({absent});
    assert.equal((await f.controller.retireAllocation(f.request)).status, 'preserved');
    assert.ok(f.poolEntry()); assert.ok(!f.calls.includes('runner.delete')); assert.ok(!f.calls.includes('compute.delete'));
  }
});
test('already absent runner and VM close read-only even when quiescence is unapproved', async () => {
  const f = fixture({absent: true}); f.setRunners([]);
  assert.equal((await f.controller.retireAllocation(f.request)).status, 'retired');
  assert.equal(f.poolEntry(), undefined); assert.equal(f.job.done, false);
  assert.ok(!f.calls.includes('runner.delete')); assert.ok(!f.calls.includes('compute.delete'));
});

test('actual proof changing during final orphan provider observations prevents deregistration', async () => {
  for (const phase of ['inspect', 'final_inventory']) {
    const f = fixture({absent: true, approvedQuiescence: true});
    function mutate() {
      const entry = f.poolEntry(); entry.actualJob.state = 'running'; f.setPoolEntry(entry);
      f.job.actualJob = JSON.stringify(entry.actualJob); delete f.job.actualCompletion;
    }
    if (phase === 'inspect') {
      const inspect = f.runnerAdapter.inspectOwnedRunner;
      f.runnerAdapter.inspectOwnedRunner = async input => {const answer = await inspect(input); mutate(); return answer;};
    } else {
      const list = f.runnerAdapter.listRunnerPage; let reads = 0;
      f.runnerAdapter.listRunnerPage = async input => {const answer = await list(input); if (++reads === 2) mutate(); return answer;};
    }
    assert.equal((await f.controller.reconcileOrphan(f.request)).status, 'preserved');
    assert.ok(f.poolEntry()); assert.ok(!f.calls.includes('runner.delete')); assert.ok(!f.calls.includes('compute.delete'));
  }
});
