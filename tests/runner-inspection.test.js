'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createGitHubAppRunnerAdapter} = require('../cloud-functions/webhook-handler/github-app-runner-adapter');
const binding = {runnerId: 7, expectedName: 'fixture-worker', expectedLabels: ['self-hosted', 'fixture-route']};
async function fixture({status, runner, permissions = {administration: 'write'}} = {}) {
  const routes = [];
  const adapter = await createGitHubAppRunnerAdapter({appId: 1, installationId: 2, repositoryId: 3,
    repositoryOwner: 'example', repositoryName: 'fixture', runnerGroupId: 1, jitReleaseWindowMs: 1000,
    privateKeyProvider: async () => 'synthetic_fixture_key'.repeat(5),
    octokitFactory: async () => ({auth: async () => ({tokenType: 'installation', permissions}),
      request: async route => {
        routes.push(route);
        if (route === 'GET /repos/{owner}/{repo}') return {data: {id: 3, full_name: 'example/fixture', private: true}};
        assert.equal(route, 'GET /repos/{owner}/{repo}/actions/runners/{runner_id}');
        if (status) throw Object.assign(Error('synthetic_provider_failure'), {status});
        return {data: runner || {id: 7, name: 'fixture-worker', busy: false,
          labels: [{name: 'self-hosted'}, {name: 'fixture-route'}]}};
      }})});
  return {adapter, routes};
}
test('exact ownership-qualified runner inspection is read-only and reports busy truthfully', async () => {
  const f = await fixture({runner: {id: 7, name: 'fixture-worker', busy: true,
    labels: [{name: 'self-hosted'}, {name: 'fixture-route'}]}});
  assert.deepEqual(await f.adapter.inspectOwnedRunner(binding), {status: 'present', busy: true});
  assert.deepEqual(await f.adapter.deregisterOwnedRunner(binding), {status: 'preserved', reason: 'busy'});
  assert.equal(f.routes.some(route => route.startsWith('DELETE')), false);
});
test('only exact permission-qualified 404 is runner absence; other provider failures preserve', async () => {
  const absent = await fixture({status: 404});
  assert.deepEqual(await absent.adapter.inspectOwnedRunner(binding), {status: 'absent'});
  for (const status of [401, 403, 429, 500, 503]) {
    const f = await fixture({status}); await assert.rejects(f.adapter.inspectOwnedRunner(binding), /BOOTSTRAP_UNAVAILABLE/);
  }
  const wrongAuthority = await fixture({status: 404, permissions: {administration: 'read'}});
  await assert.rejects(wrongAuthority.adapter.inspectOwnedRunner(binding), /BOOTSTRAP_UNAVAILABLE/);
  assert.equal(wrongAuthority.routes.length, 0);
});
test('changed ID, name or labels never count as the bound runner', async () => {
  for (const patch of [{id: 8}, {name: 'replacement-worker'}, {labels: [{name: 'self-hosted'}]}]) {
    const f = await fixture({runner: {id: 7, name: 'fixture-worker', busy: false,
      labels: [{name: 'self-hosted'}, {name: 'fixture-route'}], ...patch}});
    await assert.rejects(f.adapter.inspectOwnedRunner(binding), /BOOTSTRAP_UNAVAILABLE/);
  }
});

test('extra duplicate and malformed provider labels preserve without any delete', async () => {
  const expected = [{name: 'self-hosted'}, {name: 'fixture-route'}];
  for (const labels of [expected.concat({name: 'unexpected'}), expected.concat({name: 'fixture-route'}),
    expected.concat(null), expected.concat({}), ['self-hosted', {name: 'fixture-route'}]]) {
    const f = await fixture({runner: {id: 7, name: 'fixture-worker', busy: false, labels}});
    await assert.rejects(f.adapter.inspectOwnedRunner(binding), /BOOTSTRAP_UNAVAILABLE/);
    await assert.rejects(f.adapter.deregisterOwnedRunner(binding), /BOOTSTRAP_UNAVAILABLE/);
    assert.equal(f.routes.some(route => route.startsWith('DELETE')), false);
  }
});
test('the exact configured set including platform built-ins accepts provider label order', async () => {
  const expectedLabels = ['self-hosted', 'linux', 'x64', 'fixture-route'];
  const f = await fixture({runner: {id: 7, name: 'fixture-worker', busy: false,
    labels: [...expectedLabels].reverse().map(name => ({name}))}});
  assert.deepEqual(await f.adapter.inspectOwnedRunner({...binding, expectedLabels}), {status: 'present', busy: false});
});
