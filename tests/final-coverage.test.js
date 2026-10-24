'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { randomUUID, createHash } = require('node:crypto');
const { inputs, assemble, writeZip } = require('../packaging/assemble-controller');
const root = path.resolve(__dirname, '..');
const { fixture: lifecycleFixture } = require('./fixtures/lifecycle-fixture');
const { createRetirementController } = require('../cloud-functions/cleanup-function/retirement-controller');
const { createGitHubAppRunnerAdapter, createSecretManagerPrivateKeyProvider } = require('../cloud-functions/webhook-handler/github-app-runner-adapter');
function retirement(f, options = {}) {
  return createRetirementController({ firestore: f.firestore, compute: f.compute,
    runnerAdapter: f.runnerAdapter, projectId: f.entry.project,
    repositoryOwner: f.event.repo_owner, repositoryName: f.event.repo_name, ...options });
}

function injectedModule(relative, dependencies, globals = {}) {
  const filename = path.resolve(root, relative);
  const ordinaryRequire = Module.createRequire(filename);
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.require = name => Object.hasOwn(dependencies, name) ? dependencies[name] : ordinaryRequire(name);
  const originalArgv = process.argv;
  const originalMain = process.mainModule;
  const originalExitCode = process.exitCode;
  try {
    if (globals.argv) process.argv = globals.argv;
    if (globals.main) process.mainModule = compiled;
    compiled._compile(fs.readFileSync(filename, 'utf8'), filename);
  } finally { process.argv = originalArgv; process.mainModule = originalMain; process.exitCode=originalExitCode; }
  return compiled.exports;
}

test('assembled source preserves reviewed paths, bytes, permissions and dependency locks', () => {
  const parent = path.join(root, 'dist', 'coverage-' + randomUUID());
  try {
    const target = path.join(parent, 'controller');
    const result = assemble(target);
    const declared = inputs();
    assert.equal(result.directory, target);
    assert.equal(result.files.length, declared.length);
    for (const file of declared) {
      const written = path.join(target, file.path);
      assert.equal(fs.readFileSync(written, 'utf8'), file.content);
      assert.equal(fs.statSync(written).mode & 0o777, file.mode);
      assert.equal(result.manifest.files.find(row => row.path === file.path).sha256,
        createHash('sha256').update(file.content).digest('hex'));
    }
    assert.throws(() => assemble(target), /ARCHIVE_DESTINATION_INVALID/);
    assert.ok(declared.every(file => !file.path.includes('node_modules') && !file.path.endsWith('.test.js')));
    assert.ok(declared.some(file => file.path === 'package-lock.json'));
    for (const name of ['LICENSE', 'NOTICE.md']) {
      assert.equal(fs.readFileSync(path.join(target, name), 'utf8'), fs.readFileSync(path.join(root, name), 'utf8'));
    }
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('assembly rejects outside destinations, checkout overwrite and nonregular source leaves', () => {
  assert.throws(() => assemble(root), /ARCHIVE_DESTINATION_INVALID/);
  assert.throws(() => assemble('/tmp/synthetic-outside-controller'), /ARCHIVE_DESTINATION_INVALID/);
  for (const state of [{ isFile: () => false, isSymbolicLink: () => false },
    { isFile: () => true, isSymbolicLink: () => true }]) {
    const module = injectedModule('packaging/assemble-controller.js', {
      'node:fs': { ...fs, lstatSync: () => state },
    });
    assert.throws(() => module.inputs(), /ARCHIVE_FILE_INVALID/);
  }
});

test('archive checker writes only explicit inventories and leaves runtime inputs untouched', () => {
  const writes = [];
  const checker=injectedModule('packaging/check-controller.js', {
    'node:fs': { ...fs, writeFileSync: (destination, content) => writes.push([destination, JSON.parse(content)]) },
  });
  assert.equal(checker.check({writeInventory:true}).ok,true);
  assert.deepEqual(writes.map(([destination]) => destination),
    ['archive-manifest.json','declared-imports.json','archive-source-map.json'].map(name=>path.join(root,'deployment',name)));
  assert.equal(writes[0][1].runtime, 'nodejs24');
  assert.ok(writes[0][1].files.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
  assert.ok(writes[1][1].some(descriptor => descriptor.from === 'controller-entry.js'));
});

test('archive checker reports malformed tracked inventory and refuses to regenerate invalid source modes/imports',()=>{
  const writes=[];
  const checker=injectedModule('packaging/check-controller.js',{'node:fs':{...fs,
    readFileSync:(filename,...args)=>filename===path.join(root,'deployment/archive-manifest.json')?'{broken':fs.readFileSync(filename,...args),
    writeFileSync:(...args)=>writes.push(args)}});
  assert.ok(checker.check().errors.includes('ARCHIVE_INVENTORY_STALE'));assert.deepEqual(writes,[]);
  const changed=inputs().map(f=>f.path==='controller-entry.js'?{...f,mode:0o600,content:f.content+"\nrequire('node:child_process');\n"}:f);
  const result=injectedModule('packaging/check-controller.js',{
    './assemble-controller':{inputs:()=>changed,guardPath(){}},
    'node:fs':{...fs,writeFileSync:(...args)=>writes.push(args)}}).check({writeInventory:true});
  assert.ok(result.errors.includes('ARCHIVE_MODE_INVALID'));assert.ok(result.errors.includes('ARCHIVE_BUILTIN_UNREVIEWED'));
  assert.deepEqual(writes,[]);
  injectedModule('packaging/check-controller.js',{'./assemble-controller':{inputs:()=>changed,guardPath(){}}},
    {argv:['node',path.join(root,'packaging/check-controller.js')],main:true});
});

test('assembly CLI creates its manifest for both explicit and default destinations', () => {
  for (const destination of [undefined, path.join(root, 'dist', 'synthetic-cli', 'controller')]) {
    const writes = [];
    const executed=[];
    const argv = ['node', path.join(root, 'packaging/assemble-controller.js')];
    if (destination) argv.push(destination);
    injectedModule('packaging/assemble-controller.js', { 'node:fs': { ...fs,
      existsSync: () => false, mkdirSync() {}, chmodSync() {},
      readFileSync: (filename,...args)=>writes.find(([name])=>name===filename)?.[1] ?? fs.readFileSync(filename,...args),
      writeFileSync: (filename, content) => writes.push([filename, content]),
    }, 'node:child_process': {execFileSync:(command,args)=>{
      executed.push([command,...args]);
      if(command==='git') {
        if(args.includes('status'))return args.includes('--untracked-files=all')?writes.map(([name])=>'?? '+path.relative(root,name)+'\0').join(''):'';
        if(args.includes('ls-tree'))return [...new Set([...inputs().map(f=>f.source),'packaging/assemble-controller.js','packaging/check-controller.js','packaging/archive-closure.js','packaging/controller-zip.py','packaging/dependency-contract.js','package.json','cloud-functions/webhook-handler/package.json','cloud-functions/cleanup-function/package.json','package-lock.json','source-compatible/templates/package-lock.json','source-compatible/templates/cloud-functions/hybrid-cleanup-handler/package-lock.json','terraform/.terraform.lock.hcl','deployment/archive-manifest.json','deployment/declared-imports.json','deployment/archive-source-map.json'])].map(name=>`${fs.statSync(path.join(root,name)).mode&0o111?'100755':'100644'} blob ${'c'.repeat(40)}\t${name}`).join('\n');
        if(args.includes('show'))return fs.readFileSync(path.join(root,args.at(-1).split(':').slice(1).join(':')));
        return args.includes('HEAD^{tree}')?'b'.repeat(40):'a'.repeat(40);
      }
      if(command===process.execPath)return JSON.stringify({ok:true,inventoryConsistent:true});
      if(command==='npm')return '11.6.2';
      if(args[0]==='--version')return 'Python 3.14.6';
      return JSON.stringify({ok:true,fileCount:writes.length-1,archiveSha256:'a'.repeat(64)});
    }} }, { argv, main: true });
    const directory = destination || path.join(root, 'dist', 'controller');
    const manifest = JSON.parse(writes.find(([filename]) => filename === path.join(directory, '..', 'controller-manifest.json'))[1]);
    assert.equal(manifest.entry, 'controller-entry.js');
    assert.equal(writes.length, manifest.files.length + 2);
    const receipt=JSON.parse(writes.find(([filename])=>filename===path.join(directory,'..','controller-receipt.json'))[1]);
    assert.deepEqual(receipt.commands[1].argv,executed.find(argv=>argv[0]==='python3' && argv[1].endsWith('controller-zip.py')));
  }
});

test('actual ZIP entries match source bytes and Unix modes, and repeated destination is refused',()=> {
  const parent=path.join(root,'dist','zip-'+randomUUID());
  try {
    const result=assemble(path.join(parent,'controller')),manifestPath=path.join(parent,'manifest.json'),archive=path.join(parent,'controller.zip');
    fs.writeFileSync(manifestPath,JSON.stringify(result.manifest));
    const receipt=writeZip(result,archive,manifestPath);assert.equal(receipt.ok,true);assert.equal(receipt.fileCount,result.files.length);assert.match(receipt.archiveSha256,/^[a-f0-9]{64}$/);
    assert.equal(receipt.archiveSha256,createHash('sha256').update(fs.readFileSync(archive)).digest('hex'));
    assert.throws(()=>writeZip(result,archive,manifestPath));
    fs.chmodSync(path.join(result.directory,'controller-entry.js'),0o600);
    assert.throws(()=>writeZip(result,path.join(parent,'wrong-mode.zip'),manifestPath),/ARCHIVE_MODE_MISMATCH/);
  }finally{fs.rmSync(parent,{recursive:true,force:true});}
});

test('retirement rejects incomplete configuration and malformed requests before provider reads', async () => {
  const f = lifecycleFixture();
  for (const option of ['projectId', 'repositoryOwner', 'repositoryName'])
    assert.throws(() => retirement(f, { [option]: '' }), /invalid_retirement_configuration/);
  for (const request of [null, {}, ...['key', 'token', 'name', 'zone', 'instanceId'].map(field => ({ ...f.request, [field]: '' })),
    { ...f.request, project: 'other-project' }]) {
    for (const method of ['requestDrain', 'prepareStop', 'retireAllocation', 'reconcileOrphan'])
      assert.equal((await retirement(f)[method](request)).status, 'preserved');
  }
  assert.deepEqual(f.calls, []);
});

test('unknown pool codecs and VM metadata preserve ownership without any mutation', async () => {
  for (const value of [undefined, {}, 'null', '[]', '{']) {
    const f = lifecycleFixture({ status: 'TERMINATED' }); f.pool.entries = value;
    assert.equal((await retirement(f).retireAllocation(f.request)).status, 'preserved');
    assert.equal(f.calls.includes('delete'), false);
  }
  for (const metadata of [undefined, {}, { items: [] }, { items: [{ key: 1, value: 'synthetic' }] },
    { items: [{ key: 'allocation-key', value: 1 }] },
    { items: [{ key: 'allocation-key', value: 'synthetic' }, { key: 'allocation-key', value: 'synthetic' }] }]) {
    const f = lifecycleFixture({ status: 'TERMINATED' }); f.getVm().metadata = metadata;
    assert.equal((await retirement(f).retireAllocation(f.request)).status, 'preserved');
    assert.equal(f.calls.includes('delete'), false); assert.equal(f.calls.includes('deregister'), false);
  }
});

test('runner inventory rejects malformed, incomplete, duplicated or unbounded provider pages', async () => {
  const row = { id: 1, name: 'synthetic', busy: false };
  const pages = [null, { total_count: -1, runners: [] }, { total_count: 1.5, runners: [] },
    { total_count: 0, runners: null }, { total_count: 101, runners: Array(101).fill(row) },
    ...[{ id: 0 }, { id: 1.5 }, { name: null }, { busy: null }].map(change => ({ total_count: 1, runners: [{ ...row, ...change }] })),
    { total_count: 2, runners: [row] }, { total_count: 2, runners: [row, row] },
    { total_count: 2, runners: [row, { ...row, id: 2 }] }];
  for (const page of pages) {
    const f = lifecycleFixture(); f.runnerAdapter.listRunnerPage = async () => page;
    await assert.rejects(retirement(f).inventory(), /cleanup_inventory_/);
  }
  const changed = lifecycleFixture();
  changed.runnerAdapter.listRunnerPage = async ({ page }) => ({ total_count: page === 1 ? 101 : 102,
    runners: page === 1 ? Array.from({ length: 100 }, (_, i) => ({ ...row, id: i + 1, name: 'synthetic-' + i })) : [] });
  await assert.rejects(retirement(changed).inventory(), /cleanup_inventory_changed/);
  const bounded = lifecycleFixture(); let pagesRead = 0;
  bounded.runnerAdapter.listRunnerPage = async () => { pagesRead++; return { total_count: 10000, runners: Array(100).fill(row) }; };
  await assert.rejects(retirement(bounded).inventory(), /cleanup_inventory_limit/);
  assert.equal(pagesRead, 100);
});

function appFixture() {
  const f = { runner: { id: 7, name: 'synthetic-worker', busy: false, labels: [{ name: 'self-hosted' }, { name: 'fixture-route' }] },
    repository: { id: 3, full_name: 'example/fixture', private: true },
    authority: { tokenType: 'installation', permissions: { administration: 'write' } },
    page: undefined, registration: { token: 'fixture', expires_at: '1970-01-01T00:03:20Z' },
    calls: [] };
  f.client = { auth: async () => f.authority, request: async route => {
    f.calls.push(route);
    if (route === 'GET /repos/{owner}/{repo}') return { data: f.repository };
    if (route.endsWith('/registration-token')) return { data: f.registration };
    if (route === 'GET /repos/{owner}/{repo}/actions/runners')
      return { data: f.page === undefined ? { total_count: f.runner ? 1 : 0, runners: f.runner ? [f.runner] : [] } : f.page };
    if (route.startsWith('DELETE ')) { if (f.deleteError) throw f.deleteError; f.runner = null; return {}; }
    if (f.runnerError) throw f.runnerError;
    if (!f.runner) throw { status: 404 };
    return { data: f.runner };
  } };
  f.options = { appId: 1, installationId: 2, repositoryId: 3, repositoryOwner: 'example', repositoryName: 'fixture',
    privateKeyProvider: async () => 'fixture', runnerGroupId: 1, jitReleaseWindowMs: 1000,
    clock: () => 100000, octokitFactory: async () => f.client };
  f.create = options => createGitHubAppRunnerAdapter({ ...f.options, ...options });
  f.input = { runnerId: 7, expectedName: 'synthetic-worker', expectedLabels: ['self-hosted', 'fixture-route'] };
  return f;
}

test('App adapter and versioned key provider reject malformed configuration and unavailable material', async () => {
  for (const change of [{ appId: 0 }, { installationId: 1.5 }, { repositoryId: 0 }, { runnerGroupId: -1 },
    { repositoryOwner: '' }, { repositoryName: 'bad/name' }, { privateKeyProvider: null },
    { jitReleaseWindowMs: 999 }, { jitReleaseWindowMs: 600001 },
    { privateKeyProvider: async () => null }, { privateKeyProvider: async () => 'a'.repeat(16385) },
    { privateKeyProvider: async () => { throw Error('synthetic'); } }])
    await assert.rejects(appFixture().create(change), error => error.code === 'BOOTSTRAP_UNAVAILABLE');
  const version = 'projects/example-project/secrets/fixture/versions/1';
  for (const options of [{ secretVersion: 'invalid', secretManagerClient: {} },
    { secretVersion: version, secretManagerClient: null }, { secretVersion: version, secretManagerClient: {} }])
    assert.throws(() => createSecretManagerPrivateKeyProvider(options));
  for (const data of [{}, { payload: {} }, { payload: { data: Buffer.from('short') } },
    { payload: { data: Buffer.alloc(16385) } }])
    await assert.rejects(createSecretManagerPrivateKeyProvider({ secretVersion: version,
      secretManagerClient: { accessSecretVersion: async () => [data] } })());
  const value = 'synthetic-fixture-value'.repeat(4);
  const provider = createSecretManagerPrivateKeyProvider({ secretVersion: version,
    secretManagerClient: { accessSecretVersion: async input => { assert.equal(input.name, version); return [{ payload: { data: Buffer.from(value) } }]; } } });
  assert.equal(await provider(), value);
  const { Octokit } = await import('@octokit/rest');
  const original = Object.getOwnPropertyDescriptor(Octokit.prototype, 'log');
  let logger;
  Object.defineProperty(Octokit.prototype, 'log', { configurable: true,
    get: () => logger, set: value => { logger = value; } });
  try {
    const adapter = await appFixture().create({ octokitFactory: undefined });
    assert.equal(typeof adapter.listRunnerPage, 'function'); // No auth or requests.
    // The production SDK logger must discard provider material at every level.
    for (const level of ['debug', 'info', 'warn', 'error'])
      assert.equal(logger[level]('synthetic-material'), undefined);
  } finally {
    if (original) Object.defineProperty(Octokit.prototype, 'log', original);
    else delete Octokit.prototype.log;
  }
});

test('App repository authority and registration lifetimes are checked on every operation', async () => {
  for (const authority of [null, {}, { tokenType: 'app' }, { tokenType: 'installation' },
    { tokenType: 'installation', permissions: {} }]) {
    const f = appFixture(); f.authority = authority;
    await assert.rejects((await f.create()).mintRegistration());
  }
  for (const repository of [null, { id: 4 }, { id: 3, full_name: null },
    { id: 3, full_name: 'example/other', private: true }, { id: 3, full_name: 'example/fixture', private: false }]) {
    const f = appFixture(); f.repository = repository;
    await assert.rejects((await f.create()).mintRegistration());
  }
  for (const registration of [{ token: null, expires_at: '1970-01-01T00:03:20Z' },
    { token: '', expires_at: '1970-01-01T00:03:20Z' }, { token: 'fixture', expires_at: 'invalid' },
    { token: 'fixture', expires_at: '1970-01-01T00:01:40Z' }]) {
    const f = appFixture(); f.registration = registration;
    await assert.rejects((await f.create()).mintRegistration());
  }
  const f = appFixture(); assert.deepEqual(await (await f.create()).mintRegistration(),
    { token: 'fixture', providerExpiresAtMs: 200000 });
});

test('read-only repository verification observes visibility changes without permitting runner operations',async()=>{
  const f=appFixture(),adapter=await f.create();
  assert.equal(await adapter.verifyPrivateRepository(),true);
  f.repository.private=false;
  assert.equal(await adapter.verifyPrivateRepository(),false);
  await assert.rejects(adapter.mintRegistration());
  await assert.rejects(adapter.mintJit({}));
  await assert.rejects(adapter.listRunnerPage({page:1}));
  await assert.rejects(adapter.deregisterOwnedRunner(f.input));
  assert.equal(f.calls.some(route=>/^(POST|DELETE)/.test(route)),false);
});

test('App runner observations require exact labels and paginated inventory integrity', async () => {
  for (const change of [{ runnerId: 0 }, { expectedName: null }, { expectedLabels: [] }])
    await assert.rejects((await appFixture().create()).inspectOwnedRunner({ ...appFixture().input, ...change }));
  for (const runner of [null, { id: 8 }, { id: 7, name: 'other' },
    { id: 7, name: 'synthetic-worker', busy: null },
    { id: 7, name: 'synthetic-worker', busy: false, labels: null },
    { id: 7, name: 'synthetic-worker', busy: false, labels: [{ name: 'self-hosted' }, { name: null }] },
    { id: 7, name: 'synthetic-worker', busy: false, labels: [{ name: 'self-hosted' }, { name: 'other' }] }]) {
    const f = appFixture(); f.runner = runner;
    if (runner === null) assert.deepEqual(await (await f.create()).inspectOwnedRunner(f.input), { status: 'absent' });
    else await assert.rejects((await f.create()).inspectOwnedRunner(f.input));
  }
  const duplicate = appFixture(); duplicate.input.expectedLabels = ['self-hosted', 'linux'];
  duplicate.runner.labels = [{ name: 'self-hosted' }, { name: 'self-hosted' }];
  await assert.rejects((await duplicate.create()).inspectOwnedRunner(duplicate.input));
  const opaque = appFixture(); opaque.runnerError = { status: 503 };
  await assert.rejects((await opaque.create()).inspectOwnedRunner(opaque.input));
  for (const options of [{ page: 0 }, { page: 100001 }, { page: 1, perPage: 1 }])
    await assert.rejects((await appFixture().create()).listRunnerPage(options));
  for (const page of [null, { total_count: -1, runners: [] }, { total_count: 0, runners: null },
    { total_count: 101, runners: Array(101).fill({}) },
    ...[null, { id: 0 }, { id: 7, name: null }, { id: 7, name: 'fixture', busy: null },
      { id: 7, name: 'fixture', busy: false, labels: null },
      { id: 7, name: 'fixture', busy: false, labels: [null] }].map(runner => ({ total_count: 1, runners: [runner] }))]) {
    const f = appFixture(); f.page = page;
    await assert.rejects((await f.create()).listRunnerPage({ page: 1 }));
  }
  const dup = appFixture(); dup.page = { total_count: 2, runners: [dup.runner, dup.runner] };
  await assert.rejects((await dup.create()).listRunnerPage({ page: 1 }));
  const f = appFixture(); assert.equal((await (await f.create()).listRunnerPage({ page: 1 })).runners[0].id, 7);
});

test('App deregistration preserves busy or uncertain runners and accepts only confirmed absence', async () => {
  const busy = appFixture(); busy.runner.busy = true;
  assert.deepEqual(await (await busy.create()).deregisterOwnedRunner(busy.input), { status: 'preserved', reason: 'busy' });
  assert.equal(busy.calls.some(call => call.startsWith('DELETE')), false);
  const absent = appFixture(); absent.runner = null;
  assert.deepEqual(await (await absent.create()).deregisterOwnedRunner(absent.input), { status: 'absent' });
  const f = appFixture(); assert.deepEqual(await (await f.create()).deregisterOwnedRunner(f.input), { status: 'absent' });
  const gone = appFixture(); gone.deleteError = { status: 404 };
  assert.deepEqual(await (await gone.create()).deregisterOwnedRunner(gone.input), { status: 'preserved', reason: 'still-present' });
  const opaque = appFixture(); opaque.deleteError = null;
  const original = opaque.client.request;
  opaque.client.request = async (...args) => { if (args[0].startsWith('DELETE')) throw null; return original(...args); };
  await assert.rejects((await opaque.create()).deregisterOwnedRunner(opaque.input));
});

test('assembly refuses a symlinked output parent and never writes to its external target',()=> {
  const outside=fs.mkdtempSync('/tmp/controller-outside-'),parent=path.join(root,'dist','linked-'+randomUUID());
  try {
    fs.mkdirSync(path.dirname(parent),{recursive:true});fs.symlinkSync(outside,parent);
    assert.throws(()=>assemble(path.join(parent,'controller')),/ARCHIVE_DESTINATION_INVALID/);assert.deepEqual(fs.readdirSync(outside),[]);
  }finally{fs.rmSync(parent,{force:true});fs.rmSync(outside,{recursive:true,force:true});}
});
test('assembly refuses a source parent symlink before reading its descendant runtime files',()=> {
  const module=injectedModule('packaging/assemble-controller.js',{'node:fs':{...fs,lstatSync:filename=>filename===path.join(root,'cloud-functions')?{isSymbolicLink:()=>true}:fs.lstatSync(filename)}});
  assert.throws(()=>module.inputs(),/ARCHIVE_FILE_INVALID/);
});

test('ZIP writer rejects directory traversal in supplied directory metadata before spawning',()=> {
  assert.throws(()=>writeZip({directory:path.join(root,'..','outside')},path.join(root,'dist','unwritten.zip'),path.join(root,'dist','manifest.json')),/ARCHIVE_DESTINATION_INVALID/);
});

test('controller entry registers HTTP once and lazily reuses the production composition', async () => {
  const registrations = []; const calls = []; let deployments = 0;
  const entry = injectedModule('controller-entry.js', {
    '@google-cloud/functions-framework': { http: (...args) => registrations.push(args) },
    './cloud-functions/webhook-handler/deployment-runtime': { createProductionDeployment() {
      deployments++; return { handle: async (...args) => { calls.push(args); return 'handled'; } };
    } },
    './cloud-functions/webhook-handler/controller-runtime': { createControllerRuntime: options => ({ options }) },
  });
  assert.deepEqual(registrations, [['controllerHttp', entry.controllerHttp]]);
  const request = {}, response = {};
  assert.equal(await entry.controllerHttp(request, response), 'handled');
  assert.equal(await entry.controllerHttp(request, response), 'handled');
  assert.equal(deployments, 1); assert.deepEqual(calls, [[request, response], [request, response]]);
  assert.deepEqual(entry.createControllerDeployment({ mode: 'fixture' }), { options: { mode: 'fixture' } });
  assert.equal(entry.createControllerDeployment({}, { runtimeFactory: () => 'injected' }), 'injected');
  assert.throws(() => entry.createControllerDeployment({}, { runtimeFactory: {} }), /CONTROLLER_ENTRY_UNWIRED/);
});

test('webhook entry passes its shared validated runtime clients to controller profiles', () => {
  const runtime = { infrastructureConfig: Object.freeze({ project: 'fixture' }),
    clients: { firestore: {}, compute: {} }, registeredLabels: ['self-hosted', 'fixture-route'],
    webhookHandler() {} };
  const registrations = [];
  const entry = injectedModule('cloud-functions/webhook-handler/index.js', {
    './webhook-runtime': { createWebhookRuntime: () => runtime },
    '@google-cloud/functions-framework': { http: (...args) => registrations.push(args) },
    './controller-profile': { createControllerProfile: options => options },
  });
  assert.deepEqual(registrations, [['webhookHandler', runtime.webhookHandler]]);
  const defaults = entry.prepareControllerProfile();
  assert.equal(defaults.firestore, runtime.clients.firestore);
  assert.equal(defaults.compute, runtime.clients.compute);
  assert.equal(defaults.environment, process.env);
  const overridden = entry.prepareControllerProfile({ runnerAdapter: 'fixture-adapter',
    infrastructureConfig: {}, firestore: {}, registeredLabels: ['untrusted'] });
  assert.equal(overridden.runnerAdapter, 'fixture-adapter');
  assert.equal(overridden.infrastructureConfig, runtime.infrastructureConfig);
  assert.equal(overridden.firestore, runtime.clients.firestore);
  assert.equal(overridden.registeredLabels, runtime.registeredLabels);
});

test('bootstrap readiness validates allocation identity without consuming issuance or minting', async () => {
  const { createAllocationBootstrapBroker } = require('../cloud-functions/webhook-handler/allocation-bootstrap-broker');
  const request = { allocationKey: 'a'.repeat(64), reservationToken: '00000000-0000-4000-8000-000000000001',
    repositoryOwner: 'example', repositoryName: 'fixture', runId: '1', jobId: '2', attempt: '1', instanceId: '3' };
  let reads = 0, verified = 0, mutations = 0;
  const allocation = Object.freeze({ name: 'fixture-worker' });
  const store = { readBootstrapAllocation: async input => { reads++; assert.equal(input, request); return allocation; },
    claimBootstrap() { mutations++; }, recordBootstrapMintEvidence() { mutations++; }, commitBootstrapReceipt() { mutations++; } };
  const options = { store, verifyIdentity: async (assertion, current) => {
    verified++; assert.equal(assertion, 'fixture-assertion'); assert.equal(current, allocation);
  }, github: { mintJit() { mutations++; } }, jitProviderLifetimeQualified: true };
  const broker = createAllocationBootstrapBroker(options);
  assert.deepEqual(await broker.inspect(request, 'fixture-assertion'), { ok: true, ready: true });
  assert.deepEqual(await broker.inspect({}, 'fixture-assertion'), { ok: false, code: 'BOOTSTRAP_INVALID' });
  assert.deepEqual(await createAllocationBootstrapBroker({ ...options, jitProviderLifetimeQualified: false })
    .inspect(request, 'fixture-assertion'), { ok: false, code: 'BOOTSTRAP_UNAVAILABLE' });
  assert.deepEqual(await createAllocationBootstrapBroker({ ...options, verifyIdentity: async () => { throw new Error('synthetic'); } })
    .inspect(request, 'fixture-assertion'), { ok: false, code: 'BOOTSTRAP_UNAVAILABLE' });
  assert.equal(reads, 2); assert.equal(verified, 1); assert.equal(mutations, 0);
});
