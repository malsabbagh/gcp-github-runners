'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const {verifyRuntimeDependencyContract:verify,readRuntimeDependencyContract:read}=require('../packaging/dependency-contract');
const {inventoryLock,resolveDependency,buildInventory}=require('../scripts/dependency-inventory.cjs');
const root=path.resolve(__dirname,'..');

test('root owns the exact standalone runtime set; workspaces declare compatible test-context subsets',()=>{
  const input=read(root);assert.equal(verify(input).ok,true);
  assert.deepEqual(input.rootPackage.dependencies,input.deploymentPackage.dependencies);
  for(const workspace of Object.values(input.workspacePackages))assert.equal(workspace.private,true);
  const cli=spawnSync(process.execPath,['packaging/dependency-contract.js'],{cwd:root,encoding:'utf8'});
  assert.equal(cli.status,0,cli.stderr);assert.equal(JSON.parse(cli.stdout).ok,true);
});
test('direct-set, version, runtime, module format and lock drift are rejected',()=>{
  for(const change of [
    i=>delete i.deploymentPackage.dependencies['@octokit/auth-app'],
    i=>i.deploymentPackage.dependencies['@octokit/rest']='21.0.0',
    i=>i.rootPackage.dependencies['@octokit/rest']='^20.1.2',
    i=>i.rootPackage.engines.node='>=24',
    i=>i.deploymentPackage.type='module',
    i=>i.rootPackage.main='other.js',
    i=>i.rootPackage.optionalDependencies={hidden:'1.0.0'},
    i=>i.deploymentPackage.peerDependencies={hidden:'1.0.0'},
    i=>i.rootLock.packages[''].dependencies['@octokit/rest']='21.0.0',
    i=>i.deploymentLock.packages['node_modules/@octokit/rest'].version='21.0.0',
    i=>delete i.rootLock.packages['node_modules/@octokit/auth-app'].integrity,
    i=>i.rootLock.packages['node_modules/@octokit/auth-app'].integrity=i.rootLock.packages['node_modules/@google-cloud/compute'].integrity,
    i=>i.deploymentLock.lockfileVersion=2,
    i=>i.deploymentLock.packages[''].engines.node='22.x',
  ]) {const input=read(root);change(input);assert.equal(verify(input).ok,false);}
});
test('workspace role, module, engine, declaration and lock drift fail without changing deployment entry points',()=>{
  for(const change of [
    i=>i.rootPackage.workspaces.push('unreviewed-workspace'),
    i=>delete i.workspacePackages['cloud-functions/cleanup-function'],
    i=>i.workspacePackages['cloud-functions/webhook-handler'].type='module',
    i=>i.workspacePackages['cloud-functions/webhook-handler'].private=false,
    i=>i.workspacePackages['cloud-functions/cleanup-function'].engines.node='22.x',
    i=>i.workspacePackages['cloud-functions/cleanup-function'].dependencies['unreviewed-sdk']='1.0.0',
    i=>i.workspacePackages['cloud-functions/cleanup-function'].optionalDependencies={hidden:'1.0.0'},
    i=>i.rootLock.packages['cloud-functions/cleanup-function'].dependencies={},
  ]) {const input=read(root);change(input);assert.ok(verify(input).errors.includes('DEPENDENCY_WORKSPACE_MISMATCH'));}
});
test('malformed manifest inputs and missing files fail with bounded dependency diagnostics',t=>{
  for(const input of [undefined,null,{}, {rootPackage:null},{rootPackage:{dependencies:[]}},
    {...read(root),rootLock:null}, {...read(root),deploymentPackage:{dependencies:null}}])assert.equal(verify(input).ok,false);
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dependency-contract-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  fs.mkdirSync(path.join(directory,'packaging'));fs.copyFileSync(path.join(root,'packaging/dependency-contract.js'),path.join(directory,'packaging/dependency-contract.js'));
  const result=spawnSync(process.execPath,[path.join(directory,'packaging/dependency-contract.js')],{encoding:'utf8'});
  assert.equal(result.status,1);assert.deepEqual(JSON.parse(result.stdout).errors,['DEPENDENCY_INPUT_INVALID']);
  const outside=path.join(directory,'outside.json');fs.writeFileSync(outside,'{"private":"DO_NOT_READ"}');
  fs.symlinkSync(outside,path.join(directory,'package.json'));
  assert.throws(()=>read(directory),/DEPENDENCY_INPUT_INVALID/);
});
function lockFixture() {
  return {lockfileVersion:3,packages:{
    '':{dependencies:{sdk:'1.0.0'},devDependencies:{tool:'1.0.0'}},
    'node_modules/sdk':{version:'1.0.0',dependencies:{uuid:'^9.0.1','@scope/adapter':'1.0.0'}},
    'node_modules/sdk/node_modules/uuid':{version:'9.0.1'},
    'node_modules/@scope/adapter':{version:'1.0.0',dependencies:{uuid:'^8.3.2'}},
    'node_modules/uuid':{version:'8.3.2'},
    'node_modules/tool':{version:'1.0.0',dependencies:{uuid:'^8.3.2',sdk:'1.0.0'},peerDependencies:{optionalPeer:'*'}},
  }};
}
test('nested physical locations and scoped owners retain distinct versions and shared contexts',()=>{
  const lock=lockFixture();assert.equal(resolveDependency(lock.packages,'node_modules/sdk','uuid'),'node_modules/sdk/node_modules/uuid');
  assert.equal(resolveDependency(lock.packages,'node_modules/@scope/adapter','uuid'),'node_modules/uuid');
  assert.equal(resolveDependency(lock.packages,'','absent'),null);
  const data=inventoryLock(lock,'maintainer-and-runtime');assert.equal(data.occurrences.length,2);
  const nested=data.occurrences.find(r=>r.location==='node_modules/sdk/node_modules/uuid');
  assert.equal(nested.version,'9.0.1');assert.deepEqual(nested.reachability,['production','tooling']);
  assert.deepEqual(nested.representativePaths.production,['sdk@1.0.0','uuid@9.0.1']);
  const hoisted=data.occurrences.find(r=>r.location==='node_modules/uuid');
  assert.equal(hoisted.version,'8.3.2');assert.ok(hoisted.owners.some(o=>o.package==='@scope/adapter'));
});
test('workspace links, reference roles, optional edges and cycles are bounded rather than conflated',()=>{
  const lock=lockFixture();lock.packages['node_modules/workspace']={link:true,resolved:'packages/workspace'};
  lock.packages['packages/workspace']={version:'1.0.0',dependencies:{sdk:'1.0.0'},devDependencies:{tool:'1.0.0'}};
  lock.packages['node_modules/sdk'].dependencies.workspace='*';
  lock.packages['node_modules/sdk'].optionalDependencies={uuid:'^9.0.1',missingOptional:'*'};
  assert.equal(resolveDependency(lock.packages,'','workspace'),'packages/workspace');
  const data=inventoryLock(lock,'reference-only');
  assert.ok(data.occurrences.every(o=>o.reachability.every(c=>c.startsWith('reference-'))));
  assert.ok(data.occurrences.some(o=>o.owners.some(edge=>edge.kind==='optional')));
});
test('unresolved required roots/edges, invalid links and unsafe lock paths fail rather than inventing inventory',()=>{
  for(const mutate of [
    l=>delete l.packages['node_modules/sdk'],
    l=>l.packages['node_modules/sdk'].dependencies.absent='1.0.0',
    l=>l.packages['node_modules/sdk']={link:true,resolved:'missing'},
    l=>l.packages['../outside']={version:'1.0.0'},
  ]) {const input=lockFixture();mutate(input);assert.throws(()=>inventoryLock(input,'maintainer-and-runtime'),/DEPENDENCY_GRAPH/);}
  assert.throws(()=>inventoryLock({},'reference-only'),/DEPENDENCY_GRAPH_INVALID/);
});
test('the tracked four-lock inventory is deterministic and includes the scoped/unscoped once distinction',()=>{
  const inventory=buildInventory(root);assert.deepEqual(inventory,JSON.parse(fs.readFileSync(path.join(root,'deployment/dependency-inventory.json'))));
  const assessment=JSON.parse(fs.readFileSync(path.join(root,'deployment/dependency-status.json')));
  assert.deepEqual(assessment.lockSha256,Object.fromEntries(inventory.locks.map(l=>[l.path,l.sha256])));
  assert.equal(inventory.locks.length,4);
  for(const lock of inventory.locks) {
    assert.match(lock.sha256,/^[a-f0-9]{64}$/);
    assert.ok(lock.occurrences.some(o=>o.package==='@tootallnate/once'&&o.version==='2.0.1'));
    assert.ok(lock.occurrences.some(o=>o.package==='once'&&o.version==='1.4.0'));
  }
});
test('missing standalone dependencies cannot be satisfied by the populated root node_modules',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'standalone-no-fallback-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  fs.copyFileSync(path.join(root,'deployment/deployment-package.json'),path.join(directory,'package.json'));
  const environment={...process.env,CONTROLLER_QUALIFICATION_DIR:directory};delete environment.NODE_PATH;delete environment.NODE_OPTIONS;
  // A fresh runner must execute its own tests rather than inherit the parent test context.
  delete environment.NODE_TEST_CONTEXT;
  const result=spawnSync(process.execPath,['--test',path.join(root,'tests/dependencies/standalone.cjs')],{cwd:directory,env:environment,encoding:'utf8'});
  assert.notEqual(result.status,0);assert.match(result.stdout+result.stderr,/MODULE_NOT_FOUND/);
});
test('inventory CLI checks never write; explicit regeneration exposes stale assessments and refuses output symlinks',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'inventory-cli-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const files=['scripts/dependency-inventory.cjs','deployment/dependency-inventory.json','deployment/dependency-status.json',
    ...buildInventory(root).locks.map(lock=>lock.path)];
  for(const name of files){fs.mkdirSync(path.dirname(path.join(directory,name)),{recursive:true});fs.copyFileSync(path.join(root,name),path.join(directory,name));}
  const run=arg=>spawnSync(process.execPath,[path.join(directory,'scripts/dependency-inventory.cjs'),arg],{encoding:'utf8'});
  const contract=path.join(directory,'deployment/dependency-inventory.json');const before=fs.readFileSync(contract);const stamp=fs.statSync(contract).mtimeMs;
  assert.equal(run('--check').status,0);assert.deepEqual(fs.readFileSync(contract),before);assert.equal(fs.statSync(contract).mtimeMs,stamp);
  fs.appendFileSync(path.join(directory,'package-lock.json'),'\n');
  assert.match(run('--check').stderr,/DEPENDENCY_INVENTORY_STALE/);assert.deepEqual(fs.readFileSync(contract),before);
  assert.equal(run('--write').status,0);assert.match(run('--check').stderr,/DEPENDENCY_ASSESSMENT_STALE/);
  const status=path.join(directory,'deployment/dependency-status.json');const observation=JSON.parse(fs.readFileSync(status));
  observation.lockSha256=Object.fromEntries(buildInventory(directory).locks.map(lock=>[lock.path,lock.sha256]));fs.writeFileSync(status,JSON.stringify(observation));
  assert.equal(run('--check').status,0);assert.match(run('--invalid').stderr,/DEPENDENCY_INVENTORY_ARGUMENT_INVALID/);
  const marker=path.join(directory,'marker.json');fs.writeFileSync(marker,'preserve');fs.unlinkSync(contract);fs.symlinkSync(marker,contract);
  assert.match(run('--write').stderr,/DEPENDENCY_INVENTORY_PATH_INVALID/);assert.equal(fs.readFileSync(marker,'utf8'),'preserve');
});
