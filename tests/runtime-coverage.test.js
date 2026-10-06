'use strict';
// Offline contract regressions. Clients are injected; no SDK/API/secret access.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBootstrapHttpHandler } = require('../cloud-functions/webhook-handler/bootstrap-http');
const { createManagedInstanceVerifier } = require('../cloud-functions/webhook-handler/managed-instance-verifier');
const { identity } = require('../cloud-functions/webhook-handler/job-identity');
const { readBootstrapConfiguration } = require('../cloud-functions/webhook-handler/bootstrap-runtime');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

// Compile the actual module with dependency factories supplied by the test.
// The production code and its public composition seam are unchanged; these
// tests assert lazy construction without loading SDKs or contacting providers.
function loadWithDependencies(name, dependencies) {
  const filename = path.resolve(__dirname, '../cloud-functions/webhook-handler', name);
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  const ordinaryRequire = Module.createRequire(filename);
  compiled.require = name => Object.hasOwn(dependencies, name) ? dependencies[name] : ordinaryRequire(name);
  compiled._compile(fs.readFileSync(filename, 'utf8'), filename);
  return compiled.exports;
}
function bootstrapEnvironment() {
  return { GITHUB_APP_ID: '1', GITHUB_APP_INSTALLATION_ID: '2', GITHUB_REPOSITORY_ID: '3',
    RUNNER_GROUP_ID: '4', GITHUB_APP_PRIVATE_KEY_VERSION: 'projects/example-project/secrets/example-key/versions/1',
    JIT_RELEASE_WINDOW_MS: '1000', GITHUB_REPO_OWNER: 'example', GITHUB_REPO_NAME: 'fixture',
    RUNNER_ROUTING_LABEL: 'fixture-route' };
}

function response() {
  return { headers: {}, set(k, v) { this.headers[k] = v; },
    status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
}
function request() {
  return { method: 'POST', rawBody: Buffer.from('{}'), body: {},
    operation: 'exchange', authorization: 'Bearer ' + 'a'.repeat(64), json: true,
    get(key) { return key === 'authorization' ? this.authorization : this.operation; },
    is() { return this.json; } };
}

test('bootstrap HTTP guards malformed input before any broker call', async () => {
  let calls = 0;
  const broker = { inspect() { calls++; }, exchange() { calls++; } };
  const denied = response();
  await createBootstrapHttpHandler({ broker })(request(), denied);
  assert.equal(denied.statusCode, 403);
  for (const mutate of [r => { r.method = 'GET'; }, r => { r.json = false; },
    r => { r.rawBody = '{}'; }, r => { r.rawBody = Buffer.alloc(8193); },
    r => { r.authorization = undefined; }, r => { r.authorization = 'invalid'; },
    r => { r.operation = 'unknown'; }]) {
    const req = request(); mutate(req); const res = response();
    await createBootstrapHttpHandler({ broker, transportGuard: async () => true })(req, res);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { ok: false, code: 'BOOTSTRAP_INVALID' });
  }
  assert.equal(calls, 0);
});

test('bootstrap HTTP routes readiness and strips provider details from every failure', async () => {
  for (const [code, status] of [['BOOTSTRAP_IDENTITY_REJECTED', 403], ['BOOTSTRAP_INVALID', 400],
    ['BOOTSTRAP_UNAVAILABLE', 503], ['BOOTSTRAP_REPLAY_REJECTED', 409]]) {
    const broker = { inspect: async () => ({ ok: false, code, privateDetail: 'synthetic' }) };
    const req = request(); req.operation = 'readiness'; const res = response();
    await createBootstrapHttpHandler({ broker, transportGuard: async () => true })(req, res);
    assert.equal(res.statusCode, status);
    assert.deepEqual(res.body, { ok: false, code });
    assert.equal(res.headers['Cache-Control'], 'no-store');
  }
  const res = response();
  await createBootstrapHttpHandler({ broker: { exchange: async () => { throw new Error('synthetic'); } },
    transportGuard: async () => true })(request(), res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { ok: false, code: 'BOOTSTRAP_UNAVAILABLE' });
});

test('job identities accept the default attempt and reject unsafe or malformed identities', () => {
  const input = { repo_owner: 'example', repo_name: 'fixture', run_id: 1, job_id: 2 };
  assert.deepEqual(identity(input), identity({ ...input, run_attempt: '1' }));
  assert.notEqual(identity(input).key, identity({ ...input, run_attempt: 2 }).key);
  for (const change of [{ run_id: Number.MAX_SAFE_INTEGER + 1 }, { job_id: 1.5 },
    { run_attempt: Infinity }, { repo_owner: 'bad/owner' }, { repo_name: '' },
    { run_id: 0 }, { job_id: -1 }, { run_attempt: 'invalid' }])
    assert.throws(() => identity({ ...input, ...change }));
});

function verifierFixture() {
  const audience = 'https://bootstrap.example.invalid';
  const allocation = { workerServiceAccountEmail: 'worker@example-project.iam.gserviceaccount.com',
    workerServiceAccountUniqueId: '123456', instanceId: '3', name: 'synthetic-worker',
    project: 'example-project', zone: 'example-region1-a', incarnation: '2026-10-05T00:00:00Z',
    allocationKey: 'a'.repeat(64), reservationToken: 'synthetic-nonce', repositoryOwner: 'example',
    repositoryName: 'fixture', runId: '1', jobId: '2', attempt: '1', bootstrapExpiresAtMs: 200000 };
  const payload = { iss: 'https://accounts.google.com', aud: audience, email_verified: true,
    email: allocation.workerServiceAccountEmail, sub: allocation.workerServiceAccountUniqueId,
    exp: 300, iat: 90, google: { compute_engine: { instance_id: '3', instance_name: allocation.name,
      project_id: allocation.project, zone: allocation.zone } } };
  const attrs = { 'allocation-key': allocation.allocationKey, 'reservation-token': allocation.reservationToken,
    'repo-owner': 'example', 'repo-name': 'fixture', 'run-id': '1', 'job-id': '2', 'run-attempt': '1',
    'allocation-broker-url': audience, 'bootstrap-expires-at-ms': '200000' };
  const instance = { id: '3', name: allocation.name, status: 'RUNNING', creationTimestamp: allocation.incarnation,
    scheduling: { provisioningModel: 'SPOT', instanceTerminationAction: 'DELETE' },
    serviceAccounts: [{ email: allocation.workerServiceAccountEmail }],
    networkInterfaces: [{ accessConfigs: [], ipv6AccessConfigs: [] }],
    metadata: { items: Object.entries(attrs).map(([key, value]) => ({ key, value })) } };
  const fixture = { audience, allocation, payload, instance, times: [100000, 100001] };
  fixture.config = () => ({ audience, clock: () => fixture.times.shift(),
    idTokenClient: { verifyIdToken: async () => ({ getPayload: () => fixture.payload }) },
    instancesClient: { get: async () => [fixture.instance] } });
  return fixture;
}

test('managed verifier binds signed claims, live instance, metadata and expiry', async () => {
  const f = verifierFixture();
  const result = await createManagedInstanceVerifier(f.config())('a'.repeat(64), f.allocation);
  assert.equal(result.instanceId, '3'); assert.equal(result.checkedAtMs, 100001);
  assert.equal(result.serviceAccountUniqueId, '123456');
  const alternate = verifierFixture(); alternate.payload.iss = 'accounts.google.com';
  alternate.instance.networkInterfaces = [{}];
  assert.equal((await createManagedInstanceVerifier(alternate.config())('a'.repeat(64), alternate.allocation)).name,
    alternate.allocation.name);
});

test('managed verifier rejects malformed claims, wrong incarnation, public NIC and metadata drift', async () => {
  const mutations = [f => { f.payload = null; }, f => { delete f.payload.google; },
    f => { delete f.payload.google.compute_engine; }, f => { f.payload.iss = 'invalid'; },
    f => { f.payload.aud = 'https://other.example.invalid'; }, f => { f.payload.email_verified = false; },
    f => { f.payload.email = 'other@example.invalid'; }, f => { f.payload.sub = 'other'; },
    f => { f.payload.exp = 1.5; }, f => { f.payload.iat = 1.5; }, f => { f.payload.iat = 131; },
    f => { f.payload.exp = 100; }, f => { f.payload.google.compute_engine.instance_id = '4'; },
    f => { f.payload.google.compute_engine.instance_name = 'other'; },
    f => { f.payload.google.compute_engine.project_id = 'other-project'; },
    f => { f.payload.google.compute_engine.zone = 'other-zone'; },
    f => { f.times = [100000, 99999]; }, f => { f.times = [100000, 300000]; },
    f => { f.instance = null; }, f => { f.instance.id = '4'; }, f => { f.instance.name = 'other'; },
    f => { f.instance.status = 'TERMINATED'; }, f => { f.instance.creationTimestamp = 'other'; },
    f => { delete f.instance.scheduling; }, f => { f.instance.scheduling.provisioningModel = 'STANDARD'; },
    f => { f.instance.scheduling.instanceTerminationAction = 'STOP'; },
    f => { delete f.instance.serviceAccounts; }, f => { f.instance.serviceAccounts = []; },
    f => { f.instance.serviceAccounts[0].email = 'other@example.invalid'; },
    f => { delete f.instance.networkInterfaces; }, f => { f.instance.networkInterfaces = []; },
    f => { f.instance.networkInterfaces[0].accessConfigs = [{}]; },
    f => { f.instance.networkInterfaces[0].ipv6AccessConfigs = [{}]; },
    f => { delete f.instance.metadata; }, f => { f.instance.metadata.items = {}; },
    f => { f.instance.metadata.items.push(null); },
    f => { f.instance.metadata.items[0].key = 1; }, f => { f.instance.metadata.items[0].value = 1; },
    f => { f.instance.metadata.items.push({ ...f.instance.metadata.items[0] }); },
    f => { f.instance.metadata.items[0].value = 'other'; }];
  for (const mutate of mutations) {
    const f = verifierFixture(); mutate(f);
    await assert.rejects(createManagedInstanceVerifier(f.config())('a'.repeat(64), f.allocation),
      error => error.code === 'BOOTSTRAP_IDENTITY_REJECTED');
  }
});

test('managed verifier rejects invalid constructor clients and malformed assertions', async () => {
  for (const change of [{ audience: 'http://example.invalid' }, { idTokenClient: null },
    { instancesClient: null }, { idTokenClient: {} }, { instancesClient: {} }])
    assert.throws(() => createManagedInstanceVerifier({ ...verifierFixture().config(), ...change }));
  for (const assertion of [null, 'a'.repeat(63), 'a'.repeat(16385)]) {
    const f = verifierFixture();
    await assert.rejects(createManagedInstanceVerifier(f.config())(assertion, f.allocation),
      error => error.code === 'BOOTSTRAP_IDENTITY_REJECTED');
  }
});

test('Google verifier wires official SDK constructors to the same invocation audience', async () => {
  const f = verifierFixture(); let authClients = 0; let computeClients = 0;
  const { createGoogleManagedInstanceVerifier } = loadWithDependencies('managed-instance-verifier.js', {
    'google-auth-library': { OAuth2Client: class {
      constructor() { authClients++; }
      async verifyIdToken(options) {
        assert.deepEqual(options, { idToken: 'a'.repeat(64), audience: f.audience });
        return { getPayload: () => f.payload };
      }
    } },
    '@google-cloud/compute': { InstancesClient: class {
      constructor() { computeClients++; }
      async get(options) {
        assert.deepEqual(options, { project: f.allocation.project, zone: f.allocation.zone, instance: f.allocation.name });
        return [f.instance];
      }
    } },
  });
  const result = await createGoogleManagedInstanceVerifier({ audience: f.audience, clock: () => f.times.shift() })
    ('a'.repeat(64), f.allocation);
  assert.equal(authClients, 1); assert.equal(computeClients, 1);
  assert.equal(result.instanceId, f.allocation.instanceId);
});

test('bootstrap configuration rejects missing, unsafe and out-of-policy settings', () => {
  const good = bootstrapEnvironment();
  assert.equal(readBootstrapConfiguration(good).installationId, 2);
  for (const name of ['GITHUB_APP_ID', 'GITHUB_APP_INSTALLATION_ID', 'GITHUB_REPOSITORY_ID', 'RUNNER_GROUP_ID']) {
    for (const value of [undefined, '', '0', '-1', '1.5', '9007199254740992'])
      assert.throws(() => readBootstrapConfiguration({ ...good, [name]: value }));
  }
  for (const value of [undefined, 'projects/example-project/secrets/key/versions/latest', 'invalid'])
    assert.throws(() => readBootstrapConfiguration({ ...good, GITHUB_APP_PRIVATE_KEY_VERSION: value }));
  for (const value of ['999', '600001'])
    assert.throws(() => readBootstrapConfiguration({ ...good, JIT_RELEASE_WINDOW_MS: value }));
});

test('bootstrap runtime builds once, uses the canonical store and retrieves no key for readiness', async () => {
  const counts = { stores: 0, secrets: 0, adapters: 0, mints: 0 };
  const canonicalFirestore = {};
  const dependencies = {
    './allocation-bootstrap-store': { ...require('../cloud-functions/webhook-handler/allocation-bootstrap-store'),
      createAllocationBootstrapStore: options => { counts.stores++; assert.equal(options.firestore, canonicalFirestore); return {}; } },
    './managed-instance-verifier': { createGoogleManagedInstanceVerifier: () => async () => ({}) },
    './github-app-runner-adapter': {
      createSecretManagerPrivateKeyProvider: () => { counts.secrets++; return async () => 'synthetic'; },
      createGitHubAppRunnerAdapter: () => { counts.adapters++; return {
        mintJit: async () => { counts.mints++; return { ok: true }; } }; } },
    '@google-cloud/secret-manager': { SecretManagerServiceClient: class {} },
    './allocation-bootstrap-broker': { createAllocationBootstrapBroker: options => ({
      inspect: async () => ({ ok: true }), exchange: async () => options.github.mintJit({}) }) },
  };
  const { createBootstrapRuntime } = loadWithDependencies('bootstrap-runtime.js', dependencies);
  const base = { infrastructureConfig: { PROJECT_ID: 'example-project', DEFAULT_ZONE: 'synthetic-a',
    ALLOCATION_BROKER_URL: 'https://bootstrap.example.invalid', FIRESTORE_DATABASE_ID: 'fixture-store',
    WORKER_SERVICE_ACCOUNT_UNIQUE_ID: '123456' }, firestore: canonicalFirestore,
    repositoryOwner: 'example', repositoryName: 'fixture', registeredLabels: ['self-hosted', 'fixture-route'],
    routingLabel: 'fixture-route', appConfig: readBootstrapConfiguration(bootstrapEnvironment()),
    transportGuard: async () => true, jitProviderLifetimeQualified: true };
  const runtime = createBootstrapRuntime(base);
  const readiness = request(); readiness.operation = 'readiness'; const ready = response();
  await runtime.handle(readiness, ready);
  assert.equal(ready.statusCode, 200); assert.deepEqual(counts, { stores: 1, secrets: 0, adapters: 0, mints: 0 });
  for (let i = 0; i < 2; i++) {
    const res = response(); await runtime.handle(request(), res); assert.equal(res.statusCode, 200);
  }
  assert.deepEqual(counts, { stores: 1, secrets: 1, adapters: 1, mints: 2 });
  const userInfo = new URL('https://example.invalid');
  userInfo.username = 'synthetic-user'; userInfo.password = 'fixture';
  const passwordOnly = new URL('https://example.invalid'); passwordOnly.password = 'fixture';
  for (const override of [{ infrastructureConfig: null }, { firestore: null }, { appConfig: null },
    { infrastructureConfig: { ...base.infrastructureConfig, ALLOCATION_BROKER_URL: undefined } },
    { infrastructureConfig: { ...base.infrastructureConfig, FIRESTORE_DATABASE_ID: undefined } },
    { infrastructureConfig: { ...base.infrastructureConfig, WORKER_SERVICE_ACCOUNT_UNIQUE_ID: undefined } },
    ...['http://example.invalid', userInfo.href, passwordOnly.href, 'https://example.invalid/?q=1',
      'https://example.invalid/#fragment'].map(url => ({ infrastructureConfig: { ...base.infrastructureConfig, ALLOCATION_BROKER_URL: url } }))]) {
    const res = response(); await createBootstrapRuntime({ ...base, ...override }).handle(request(), res);
    assert.equal(res.statusCode, 503); assert.deepEqual(res.body, { ok: false, code: 'BOOTSTRAP_UNAVAILABLE' });
  }
  const res = response(); await createBootstrapRuntime({ ...base, transportGuard: async () => { throw Error('synthetic'); } }).handle(request(), res);
  assert.equal(res.statusCode, 503);
  const denied = response(); await createBootstrapRuntime({ ...base, transportGuard: undefined }).handle(request(), denied);
  assert.equal(denied.statusCode, 403);
  const unqualified = response(); await createBootstrapRuntime({ ...base, jitProviderLifetimeQualified: false }).handle(request(), unqualified);
  assert.equal(unqualified.statusCode, 503);
});

test('controller profile validates repository scope and shares one lazy runner adapter', async () => {
  const counts = { keys: 0, adapters: 0, calls: [] };
  const make = name => options => ({ name, options });
  const dependencies = {
    './bootstrap-runtime': { readBootstrapConfiguration, createBootstrapRuntime: make('bootstrap') },
    './github-app-runner-adapter': {
      createSecretManagerPrivateKeyProvider: () => { counts.keys++; return async () => 'synthetic'; },
      createGitHubAppRunnerAdapter: () => { counts.adapters++; return Object.fromEntries(
        ['inspectOwnedRunner', 'listRunnerPage', 'deregisterOwnedRunner'].map(name => [name,
          async input => { counts.calls.push([name, input]); return { status: 'synthetic' }; }])); } },
    '@google-cloud/secret-manager': { SecretManagerServiceClient: class {} },
    '../cleanup-function/retirement-controller': { createRetirementController: options => options.runnerAdapter },
    './actual-job-association': { createActualJobAssociation: make('association') },
    './allocation-recovery': { createAllocationRecovery: make('recovery') },
    '../cleanup-function/lifecycle-dispatcher': { createLifecycleDispatcher: make('dispatcher') },
    './scheduled-recovery': { createScheduledRecovery: make('scheduler') },
  };
  const { createControllerProfile } = loadWithDependencies('controller-profile.js', dependencies);
  const base = { infrastructureConfig: { PROJECT_ID: 'example-project' }, firestore: {}, compute: {},
    cloudBuild: {}, environment: bootstrapEnvironment(), registeredLabels: ['self-hosted', 'fixture-route'] };
  for (const environment of [{ ...base.environment, GITHUB_REPO_OWNER: '' },
    { ...base.environment, GITHUB_REPO_NAME: '' },
    { ...base.environment, GITHUB_APP_PRIVATE_KEY_VERSION: 'projects/other-project/secrets/key/versions/1' }])
    assert.throws(() => createControllerProfile({ ...base, environment }), /CONTROLLER_PROFILE_INVALID/);
  const profile = createControllerProfile(base);
  assert.equal(profile.recovery.options.firestore, base.firestore);
  assert.equal(profile.bootstrap.options.firestore, base.firestore);
  assert.equal(profile.bootstrap.options.transportGuard(), false);
  assert.equal(await profile.scheduler.options.authenticateInvocation(), null);
  assert.equal(counts.keys, 0);
  for (const name of ['inspectOwnedRunner', 'listRunnerPage', 'deregisterOwnedRunner'])
    assert.deepEqual(await profile.retirement[name]({ name }), { status: 'synthetic' });
  assert.equal(counts.adapters, 1); assert.equal(counts.keys, 1); assert.equal(counts.calls.length, 3);
  const injected = {}; assert.equal(createControllerProfile({ ...base, runnerAdapter: injected }).retirement, injected);
});
