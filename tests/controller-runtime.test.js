'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createControllerRuntime} = require('../cloud-functions/webhook-handler/controller-runtime');
const {createControllerProfile} = require('../cloud-functions/webhook-handler/controller-profile');
const authority = {expectedAudience: 'https://controller.example.invalid', expectedCallerSubject: '111111', schedulerSubject: '222222'};
const principal = {verified: true, audience: authority.expectedAudience, subject: authority.expectedCallerSubject, role: 'admin'};
const allocation = {key: 'a'.repeat(64), token: '11111111-1111-4111-8111-111111111111',
  name: 'fixture-worker', zone: 'us-central1-a', project: 'example-project', instanceId: '12345',
  instanceCreationTimestamp: '2000-01-01T00:00:00Z', claimId: '22222222-2222-4222-8222-222222222222'};
function req(operation, body = {request: allocation}) {
  return {method: 'POST', path: '/management/' + operation, originalUrl: '/management/' + operation,
    is: type => type === 'application/json', body, rawBody: Buffer.from(JSON.stringify(body)),
    get: () => undefined};
}
function res() {return {set() {}, status(code) {this.code = code; return this;}, json(body) {this.body = body; return this;}};}
function fixture(options = {}) {
  let creations = 0; const calls = [];
  const method = name => async request => {calls.push([name, request]); return {status: 'preserved', reason: 'internal_only', encodedJitConfig: 'synthetic_private_material'};};
  const runtime = createControllerRuntime({...authority, managementEnabled: true, authenticateInvocation: async () => principal,
    profileFactory: () => {creations++; return {retirement: {requestDrain: method('drain'), prepareStop: method('prepare'),
      retireAllocation: method('retire'), reconcileOrphan: method('orphan')}, dispatcher: {dispatchIntent: method('dispatch')},
      recovery: {hydrateAllocation: method('hydrate'), recoverAbsentAllocation: method('absent')},
      scheduler: {runScheduled: method('scheduled')}};}, ...options});
  return {runtime, calls, creations: () => creations};
}
test('disabled runtime needs no configuration or clients and never constructs a profile', async () => {
  let created = 0;
  const runtime = createControllerRuntime({profileFactory: () => {created++; throw Error('must_not_construct');}});
  const response = res(); await runtime.handleManagement(req('requestDrain'), response);
  assert.equal(response.code, 503); assert.equal(response.body.code, 'MANAGEMENT_DISABLED');
  assert.deepEqual(await runtime.runScheduled(req('scheduled', {})), {status: 'disabled'});
  const bootstrap = res(); await runtime.handleBootstrap({}, bootstrap); assert.equal(bootstrap.code, 403);
  assert.equal(created, 0);
});
test('authentication denial and forged request proof never construct state or adapters', async () => {
  const f = fixture({authenticateInvocation: async () => null});
  const request = req('requestDrain'); request.verified = true; request.body.verified = true;
  const response = res(); await f.runtime.handleManagement(request, response);
  assert.equal(response.code, 403); assert.equal(f.creations(), 0); assert.deepEqual(f.calls, []);
});
test('fixed routes reach only exact canonical methods with projected request and redacted response', async () => {
  const f = fixture();
  for (const [operation, name] of [['requestDrain', 'drain'], ['prepareStop', 'prepare'], ['dispatchDrain', 'dispatch'],
    ['dispatchStop', 'dispatch'], ['retire', 'retire'], ['reconcileOrphan', 'orphan'], ['recover', 'hydrate']]) {
    const response = res(); await f.runtime.handleManagement(req(operation), response);
    assert.equal(response.code, 200); assert.deepEqual(response.body, {ok: true, code: 'MANAGEMENT_HANDLED', status: 'preserved'});
    const [called, request] = f.calls.at(-1); assert.equal(called, name);
    assert.deepEqual(request, operation === 'recover' ? allocation.key :
      operation.startsWith('dispatch') ? {...allocation, phase: operation === 'dispatchDrain' ? 'drain' : 'stop'} : allocation);
  }
  assert.equal(f.creations(), 1);
});
test('scheduled entry checks exact role before lazy construction and delegates original invocation', async () => {
  const f = fixture({scheduledEnabled: true, authenticateInvocation: async () => ({...principal, subject: 'unknown'})});
  assert.deepEqual(await f.runtime.runScheduled(req('scheduled', {})), {status: 'denied'}); assert.equal(f.creations(), 0);
  const allowed = fixture({scheduledEnabled: true, authenticateInvocation: async () =>
    ({...principal, subject: authority.schedulerSubject, role: 'scheduler'})});
  const invocation = req('scheduled', {}); await allowed.runtime.runScheduled(invocation);
  assert.equal(allowed.calls[0][0], 'scheduled'); assert.equal(allowed.calls[0][1], invocation);
  const denied = res(); await allowed.runtime.handleManagement(req('dispatchStop'), denied);
  assert.equal(denied.code, 403); assert.equal(allowed.calls.length, 1);
});
test('accepted read with failed recovery persistence returns redacted unavailable without new creation', async () => {
  const calls = []; const f = fixture({profileFactory: () => ({recovery: {
    hydrateAllocation: async (key, expected) => {assert.deepEqual(expected, allocation); calls.push(['hydrate', key]); return {status: 'absent'};},
    recoverAbsentAllocation: async (key, expected) => {assert.deepEqual(expected, allocation); calls.push(['recover', key]); throw Error('synthetic_internal_error');}}})});
  const response = res(); await f.runtime.handleManagement(req('recover'), response);
  assert.equal(response.code, 503); assert.deepEqual(response.body, {ok: false, code: 'MANAGEMENT_UNAVAILABLE'});
  assert.deepEqual(calls.map(x => x[0]), ['hydrate', 'recover']);
});
test('factory flag snapshot cannot activate later from the caller options object', async () => {
  const options = {managementEnabled: false, profileFactory: () => {throw Error('must_not_construct');}};
  const runtime = createControllerRuntime(options); options.managementEnabled = true;
  const response = res(); await runtime.handleManagement(req('requestDrain'), response); assert.equal(response.code, 503);
});
test('actual disabled profile composes every canonical interface without touching injected clients', async () => {
  let effects = 0; const forbidden = async () => {effects++; throw Error('must_not_call');};
  const firestore = {doc: path => ({path}), collection: collection => ({doc: key => ({path: collection + '/' + key})}), runTransaction: forbidden};
  const profile = createControllerProfile({firestore, compute: {get: forbidden}, cloudBuild: {getBuild: forbidden},
    runnerAdapter: {listRunnerPage: forbidden, inspectOwnedRunner: forbidden, deregisterOwnedRunner: forbidden},
    workerControl: {requestDrain: forbidden, requestStop: forbidden, inspectOperation: forbidden},
    infrastructureConfig: {PROJECT_ID: 'example-project', DEFAULT_ZONE: 'us-central1-a',
      WORKER_SERVICE_ACCOUNT: 'worker@example-project.iam.gserviceaccount.com', WORKER_SERVICE_ACCOUNT_UNIQUE_ID: '123456',
      ALLOCATION_BROKER_URL: 'https://broker.example.invalid', FIRESTORE_DATABASE_ID: 'allocation-store',
      BOOTSTRAP_TTL_MS: 600000, RECONCILIATION_BATCH_SIZE: 20},
    environment: {GITHUB_APP_ID: '1', GITHUB_APP_INSTALLATION_ID: '2', GITHUB_REPOSITORY_ID: '3', RUNNER_GROUP_ID: '4',
      GITHUB_APP_PRIVATE_KEY_VERSION: 'projects/example-project/secrets/example-key/versions/1', JIT_RELEASE_WINDOW_MS: '1000',
      GITHUB_REPO_OWNER: 'example', GITHUB_REPO_NAME: 'fixture', RUNNER_ROUTING_LABEL: 'fixture-route'},
    registeredLabels: ['self-hosted', 'fixture-route']});
  assert.deepEqual(Object.keys(profile).sort(), ['association', 'bootstrap', 'dispatcher', 'recovery', 'retirement', 'scheduler']);
  assert.equal((await profile.dispatcher.dispatchIntent({...allocation, phase: 'drain'})).status, 'preserved');
  assert.deepEqual(await profile.scheduler.runScheduled({}), {status: 'disabled'});
  const response = res(); await profile.bootstrap.handle({}, response); assert.equal(response.code, 403);
  assert.equal(effects, 0);
});
