'use strict';
const mockBuild = {createBuild: jest.fn()};
jest.mock('@google-cloud/cloudbuild', () => ({CloudBuildClient: jest.fn(() => mockBuild)}));
jest.mock('@google-cloud/functions-framework', () => ({http: jest.fn(), cloudEvent: jest.fn()}));
const {createRetirementController, cleanupOldRunners} = require('./index');
function fixture({status = 'TERMINATED', terminal = true, busy = false, approvedQuiescence = true} = {}) {
  const key = 'a'.repeat(64), claimId = 'claim-one';
  const entry = {name: 'runner-vm', token: 'allocation-' + 'x'.repeat(20), zone: 'zone-a', project: 'example-project',
    instanceId: '12345', instanceCreationTimestamp: '2000-01-01T00:00:00Z', demandDone: terminal, state: 'active',
    runnerIdentity: {id: 7, name: 'runner-vm', labels: ['self-hosted', 'private-one-job']},
    bootstrap: {state: 'issued', claimId, runnerId: 7, runnerName: 'runner-vm'}};
  const event = {repo_owner: 'example-owner', repo_name: 'example-repository', job_id: 9, run_id: 12, run_attempt: 1};
  const job = {done: terminal, event: JSON.stringify(event), bootstrap: JSON.stringify(entry.bootstrap),
    completion: JSON.stringify({verifiedWebhook: true, runnerId: 7, runnerName: 'runner-vm',
      jobId: 9, runId: 12, runAttempt: 1, repositoryOwner: event.repo_owner, repositoryName: event.repo_name})};
  const pool = {entries: JSON.stringify({[key]: entry})};
  const firestore = {doc: name => ({name}), runTransaction: async work => work({
    get: async ref => ({data: () => ref.name.startsWith('provisioning_pools/') ? structuredClone(pool) : structuredClone(job)}),
    set: (ref, value, options) => {
      const object = ref.name.startsWith('provisioning_pools/') ? pool : job;
      if (!options?.merge) Object.keys(object).forEach(k => delete object[k]);
      Object.assign(object, structuredClone(value));
    }})};
  let vm = {name: entry.name, id: entry.instanceId, status, creationTimestamp: entry.instanceCreationTimestamp,
    zone: 'projects/example-project/zones/zone-a', labels: {purpose: 'github-runner'},
    metadata: {items: [{key: 'allocation-key', value: key}, {key: 'reservation-token', value: entry.token}]}};
  let runners = [{id: 7, name: entry.runnerIdentity.name, busy}];
  const compute = {get: jest.fn(async () => {if (!vm) throw {code: 5}; return [structuredClone(vm)];}),
    delete: jest.fn(async () => {vm = undefined;})};
  const runnerAdapter = {listRunnerPage: jest.fn(async ({page, perPage}) => ({total_count: runners.length,
    runners: runners.slice((page - 1) * perPage, page * perPage)})),
    deregisterOwnedRunner: jest.fn(async () => {runners = []; return {status: 'absent'};})};
  const controller = createRetirementController({firestore, compute, runnerAdapter, projectId: entry.project,
    repositoryOwner: event.repo_owner, repositoryName: event.repo_name, approvedQuiescence});
  return {key, entry, job, pool, compute, runnerAdapter, controller,
    request: {key, token: entry.token, name: entry.name, zone: entry.zone, project: entry.project,
      instanceId: entry.instanceId, instanceCreationTimestamp: entry.instanceCreationTimestamp},
    changeVm: change => {vm = {...vm, ...change};}, setRunners: rows => {runners = rows;}};
}
test('exact terminal ownership and both provider absences release the same allocation only', async () => {
  const f = fixture(); expect(await f.controller.retireAllocation(f.request)).toEqual({status: 'retired'});
  expect(f.compute.delete).toHaveBeenCalledTimes(1); expect(JSON.parse(f.pool.entries)[f.key]).toBeUndefined();
  expect(JSON.parse(f.job.cleanup)).toMatchObject({runnerAbsent: true, instanceAbsent: true});
});
test.each(['RUNNING', 'STAGING', 'STOPPING', 'UNKNOWN'])('preserves %s without deregistration', async status => {
  const f = fixture({status}); expect((await f.controller.retireAllocation(f.request)).status).toBe('preserved');
  expect(f.runnerAdapter.deregisterOwnedRunner).not.toHaveBeenCalled(); expect(f.compute.delete).not.toHaveBeenCalled();
});
test('age and original demand completion do not replace actual signed runner association', async () => {
  const f = fixture(); delete f.job.completion;
  expect((await f.controller.retireAllocation(f.request)).status).toBe('preserved');
  expect(f.compute.delete).not.toHaveBeenCalled();
});
test('different actual runner/job completion cannot retire the allocated runner', async () => {
  const f = fixture(); const proof = JSON.parse(f.job.completion); proof.runnerId = 8; f.job.completion = JSON.stringify(proof);
  expect((await f.controller.retireAllocation(f.request)).status).toBe('preserved'); expect(f.compute.delete).not.toHaveBeenCalled();
});
test('busy exact runner stays reserved', async () => {
  const f = fixture({busy: true}); await f.controller.retireAllocation(f.request);
  expect(f.compute.delete).not.toHaveBeenCalled(); expect(JSON.parse(f.pool.entries)[f.key]).toBeDefined();
});
test('unknown near-prefix runner on second page prevents retirement', async () => {
  const f = fixture(); f.setRunners(Array.from({length: 100}, (_, i) => ({id: i + 100, name: 'other-' + i, busy: false}))
    .concat([{id: 7, name: 'runner-vm', busy: false}, {id: 999, name: 'runner-vm-unknown', busy: false}]));
  await f.controller.retireAllocation(f.request); expect(f.runnerAdapter.listRunnerPage).toHaveBeenCalledWith({page: 2, perPage: 100});
  expect(f.compute.delete).not.toHaveBeenCalled();
});
test('duplicate or changed inventory totals deny', async () => {
  const f = fixture(); f.setRunners([{id: 7, name: 'runner-vm', busy: false}, {id: 7, name: 'other', busy: false}]);
  await f.controller.retireAllocation(f.request); expect(f.compute.delete).not.toHaveBeenCalled();
});
test('replacement incarnation preserves the allocation', async () => {
  const f = fixture(); f.changeVm({id: '54321'}); await f.controller.retireAllocation(f.request);
  expect(f.compute.delete).not.toHaveBeenCalled();
});
test('unknown provider errors never release capacity', async () => {
  const f = fixture(); f.compute.get.mockRejectedValue({code: 13, message: 'opaque'});
  await f.controller.retireAllocation(f.request); expect(JSON.parse(f.pool.entries)[f.key]).toBeDefined();
});
test('uncertain deletion retains retiring capacity and never stops running VMs', async () => {
  const f = fixture(); f.compute.delete.mockRejectedValue(new Error('opaque'));
  await f.controller.retireAllocation(f.request); expect(JSON.parse(f.pool.entries)[f.key].state).toBe('retiring');
  expect(f.job.cleanup).toBeUndefined();
});
test('completion or allocation change after deregistration prevents VM deletion', async () => {
  const f = fixture(); f.runnerAdapter.deregisterOwnedRunner.mockImplementation(async () => {
    const changed = JSON.parse(f.pool.entries); changed[f.key].token = 'replacement-' + 'y'.repeat(20); f.pool.entries = JSON.stringify(changed); f.setRunners([]); return {status: 'absent'};
  });
  await f.controller.retireAllocation(f.request); expect(f.compute.delete).not.toHaveBeenCalled();
});
test('invalid ages deny before asynchronous submission', async () => {
  for (const age of [-1, 1.5, NaN, '2', 8761]) await expect(cleanupOldRunners(age)).rejects.toThrow('invalid_cleanup_age');
  expect(mockBuild.createBuild).not.toHaveBeenCalled();
});

test('default unapproved quiescence prevents named instance deletion', async () => {
  const f = fixture({approvedQuiescence: false}); await f.controller.retireAllocation(f.request);
  expect(f.compute.delete).not.toHaveBeenCalled(); expect(JSON.parse(f.pool.entries)[f.key]).toBeDefined();
});
test('unknown durable allocation state never retires', async () => {
  const f = fixture(); const entries = JSON.parse(f.pool.entries); entries[f.key].state = 'unknown'; f.pool.entries = JSON.stringify(entries);
  await f.controller.retireAllocation(f.request); expect(f.compute.delete).not.toHaveBeenCalled();
});
