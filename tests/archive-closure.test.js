'use strict';
// Historical injected fixtures plus isolated local packaging CLI regressions.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { verifyDeclaredArchiveClosure } = require('../packaging/archive-closure');
const { createControllerDeployment } = require('../controller-entry');
const assembled = require('./fixtures/archive-declared-input.json');

test('actual assembled source pins and imports retain an explicit missing current lock', () => {
  const result = verifyDeclaredArchiveClosure(assembled);
  assert.equal(result.ok, false); assert.equal(result.dependencyLockConsistent, false);
  assert.deepEqual(result.errors, ['ARCHIVE_LOCK_UNRESOLVED', 'ARCHIVE_MISSING_FILE', 'ARCHIVE_UNPINNED_FILE']);
  assert.equal(assembled.manifest.files.filter(row => row.sha256 === null).length, 1);
  assert.equal(assembled.files.some(row => row.path.endsWith('/index.js')), false);
});
test('changing an actual assembled source file invalidates its declared archive pin', () => {
  const changed = structuredClone(assembled); changed.files.find(row => row.path === 'controller-entry.js').content += '\n// synthetic mutation\n';
  assert.ok(verifyDeclaredArchiveClosure(changed).errors.includes('ARCHIVE_HASH_MISMATCH'));
});
const hash = text => createHash('sha256').update(text).digest('hex');
function fixture() {
  const pkg = { name: 'fixture-controller', version: '0.0.0', private: true,
    type: 'commonjs', main: 'controller-entry.js', engines: {node: '24.x'},
    dependencies: {'fixture-sdk': '1.2.3'} };
  const lock = {lockfileVersion: 3, packages: {'': {dependencies: {...pkg.dependencies}, engines: {...pkg.engines}},
    'node_modules/fixture-sdk': {version: '1.2.3', integrity: 'sha512-Zml4dHVyZQ=='}}};
  const files = [
    {path: 'package.json', kind: 'file', content: JSON.stringify(pkg)},
    {path: 'package-lock.json', kind: 'file', content: JSON.stringify(lock)},
    {path: 'controller-entry.js', kind: 'file', content: 'fixture-entry'},
    {path: 'cloud-functions/webhook-handler/controller-profile.js', kind: 'file', content: 'fixture-profile'},
    {path: 'cloud-functions/cleanup-function/retirement-controller.js', kind: 'file', content: 'fixture-retirement'},
    {path: 'cloud-functions/cleanup-function/runner-cleanup.sh', kind: 'file', content: 'fixture-helper'}
  ];
  const manifest = {version: 1, profile: 'controller-source-archive', runtime: 'nodejs24',
    entry: 'controller-entry.js', rootPackage: 'package.json', packageLock: 'package-lock.json',
    files: files.map(row => ({path: row.path, sha256: hash(row.content)}))};
  const importDescriptors = [
    {from: 'controller-entry.js', specifier: './cloud-functions/webhook-handler/controller-profile', kind: 'lazy'},
    {from: 'cloud-functions/webhook-handler/controller-profile.js', specifier: '../cleanup-function/retirement-controller', kind: 'static'},
    {from: 'cloud-functions/webhook-handler/controller-profile.js', specifier: '../cleanup-function/runner-cleanup.sh', kind: 'asset'},
    {from: 'cloud-functions/webhook-handler/controller-profile.js', specifier: 'fixture-sdk', kind: 'lazy'},
    {from: 'cloud-functions/cleanup-function/retirement-controller.js', specifier: 'node:util', kind: 'static'}
  ];
  function rewrite(path, content) {
    files.find(row => row.path === path).content = content;
    manifest.files.find(row => row.path === path).sha256 = hash(content);
  }
  return {manifest, files, importDescriptors, lock, pkg, rewrite};
}
const inspect = f => verifyDeclaredArchiveClosure(f);
test('declared hierarchy, cross-sibling cleanup and canonical helper close in one root package', () => {
  const r = inspect(fixture()); assert.equal(r.ok, true);
  assert.equal(r.archiveClosureConsistent, true); assert.equal(r.dependencyLockConsistent, true);
  assert.equal(r.qualification, 'declared-static-consistency-only');
});
test('flattening cleanup away fails declared relative closure', () => {
  const f = fixture(); f.files = f.files.filter(row => !row.path.includes('cleanup-function/'));
  const r = inspect(f); assert.equal(r.ok, false); assert.ok(r.errors.includes('ARCHIVE_IMPORT_MISSING'));
});
test('same bytes under changed path are not the pinned archive', () => {
  const f = fixture(); f.files[2].path = 'other-entry.js'; const r = inspect(f);
  assert.equal(r.ok, false); assert.ok(r.errors.includes('ARCHIVE_MISSING_FILE'));
  assert.ok(r.errors.includes('ARCHIVE_EXTRA_FILE'));
});
test('duplicate files, traversal and symbolic links are rejected as inventory inputs', () => {
  for (const row of [{...fixture().files[2]}, {path: '../outside.js', kind: 'file', content: 'fixture'},
    {path: 'linked.js', kind: 'symlink', content: 'fixture'}]) {
    const f = fixture(); f.files.push(row); assert.equal(inspect(f).ok, false);
  }
});
test('changed bytes or unpinned required assets do not pass', () => {
  const f = fixture(); f.files[2].content = 'changed'; assert.ok(inspect(f).errors.includes('ARCHIVE_HASH_MISMATCH'));
  const other = fixture(); other.manifest.files[2].sha256 = null;
  assert.ok(inspect(other).errors.includes('ARCHIVE_UNPINNED_FILE'));
});
test('relative imports cannot escape the archive root', () => {
  const f = fixture(); f.importDescriptors.push({from: 'controller-entry.js', specifier: '../outside', kind: 'lazy'});
  assert.ok(inspect(f).errors.includes('ARCHIVE_IMPORT_ESCAPE'));
});
test('external imports require explicit direct declaration, not an incidental transitive package', () => {
  const f = fixture(); f.importDescriptors.push({from: 'controller-entry.js', specifier: 'google-auth-library', kind: 'lazy'});
  f.lock.packages['node_modules/google-auth-library'] = {version: '9.15.1', integrity: 'sha512-Zml4dHVyZQ=='};
  f.rewrite('package-lock.json', JSON.stringify(f.lock));
  assert.ok(inspect(f).errors.includes('ARCHIVE_UNDECLARED_DEPENDENCY'));
});
test('missing actual lock remains unresolved; the baseline workspace lock cannot stand in', () => {
  const f = fixture(); delete f.lock; f.files = f.files.filter(row => row.path !== 'package-lock.json');
  assert.ok(inspect(f).errors.includes('ARCHIVE_LOCK_UNRESOLVED'));
  const old = fixture(); old.lock.packages[''] = {workspaces: ['cloud-functions/webhook-handler']};
  old.rewrite('package-lock.json', JSON.stringify(old.lock));
  assert.ok(inspect(old).errors.includes('ARCHIVE_LOCK_DECLARATIONS_MISMATCH'));
});
test('lock drift, missing auth SDK record and changed direct version fail', () => {
  for (const change of [f => {delete f.lock.packages['node_modules/fixture-sdk'];},
    f => {f.lock.packages['node_modules/fixture-sdk'].version = '2.0.0';},
    f => {f.lock.packages[''].dependencies['fixture-sdk'] = '2.0.0';}]) {
    const f = fixture(); change(f); f.rewrite('package-lock.json', JSON.stringify(f.lock));
    assert.equal(inspect(f).ok, false);
  }
});
test('unreviewed process/network builtins cannot silently enter declared closure', () => {
  for (const specifier of ['node:http', 'node:child_process']) {
    const f = fixture(); f.importDescriptors.push({from: 'controller-entry.js', specifier, kind: 'static'});
    assert.ok(inspect(f).errors.includes('ARCHIVE_BUILTIN_UNREVIEWED'));
  }
});
test('wrong runtime, lifecycle scripts or workspaces in the deployment root are rejected', () => {
  for (const change of [f => {f.pkg.engines.node = '>=24';}, f => {f.pkg.scripts = {postinstall: 'fixture'};},
    f => {f.pkg.workspaces = ['fixture'];}]) {
    const f = fixture(); change(f); f.rewrite('package.json', JSON.stringify(f.pkg));
    assert.ok(inspect(f).errors.includes('ARCHIVE_PACKAGE_INVALID'));
  }
});
test('pure root factory accepts injected disabled runtime without loading SDK or adjacent source', () => {
  const options = {runtimeQualified: false}; const expected = {status: 'disabled'};
  assert.equal(createControllerDeployment(options, {runtimeFactory: value => {
    assert.equal(value, options); return expected;
  }}), expected);
});
test('malformed inputs produce only fixed diagnostic codes', () => {
  for (const input of [undefined, null, 42, {}, {manifest: null}, {manifest: {version: true}}]) {
    const result = verifyDeclaredArchiveClosure(input); assert.equal(result.ok, false);
    assert.deepEqual(result.errors, ['ARCHIVE_INPUT_INVALID']);
  }
});

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync,execFileSync} = require('node:child_process');
const root = path.resolve(__dirname,'..');
const inventories=['archive-manifest.json','declared-imports.json','archive-source-map.json'];
function packagingFixture(t) {
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'controller-inventory-')));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  for (const name of ['packaging','deployment','cloud-functions/webhook-handler','cloud-functions/cleanup-function']) {
    fs.cpSync(path.join(root,name),path.join(dir,name),{recursive:true,
      filter:source=>!source.split(path.sep).some(part=>['node_modules','coverage','__pycache__'].includes(part))});
  }
  for (const name of ['controller-entry.js','LICENSE','NOTICE.md','.gitignore','package-lock.json',
    'source-compatible/templates/package-lock.json','source-compatible/templates/cloud-functions/hybrid-cleanup-handler/package-lock.json','terraform/.terraform.lock.hcl']) {
    fs.mkdirSync(path.dirname(path.join(dir,name)),{recursive:true});fs.copyFileSync(path.join(root,name),path.join(dir,name));
  }
  const run=(script,...args)=>spawnSync(process.execPath,[path.join(dir,'packaging',script),...args],{cwd:dir,encoding:'utf8'});
  const check=(...args)=>run('check-controller.js',...args);
  const state=()=>inventories.map(name=>{const file=path.join(dir,'deployment',name);return [name,fs.readFileSync(file,'utf8'),fs.statSync(file).mtimeMs];});
  const git=(...args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8'}).trim();
  const commit=()=>{git('add','.');git('-c','user.name=Packaging Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Synthetic packaging inputs');};
  return {dir,run,check,state,git,commit};
}
test('current source contracts match actual files, mappings, modes and declared imports without rewriting',t=>{
  const f=packagingFixture(t),before=f.state(),result=f.check();
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).inventoryConsistent,true);
  assert.deepEqual(f.state(),before);
  const real=spawnSync(process.execPath,[path.join(root,'packaging/check-controller.js')],{cwd:root,encoding:'utf8'});
  assert.equal(real.status,0,real.stdout+real.stderr);
  const invalid=spawnSync(process.execPath,[path.join(root,'packaging/check-controller.js'),'--unexpected'],{cwd:root,encoding:'utf8'});
  assert.equal(invalid.status,1);assert.ok(JSON.parse(invalid.stdout).errors.includes('ARCHIVE_ARGUMENT_INVALID'));
});
test('source, standalone lock, path, mode and declared-import drift fail read-only checks; explicit regeneration restores consistency',t=>{
  const changes=[
    f=>fs.appendFileSync(path.join(f.dir,'controller-entry.js'),'\n// changed source\n'),
    f=>fs.appendFileSync(path.join(f.dir,'deployment/deployment-package-lock.json'),'\n'),
    f=>fs.writeFileSync(path.join(f.dir,'cloud-functions/webhook-handler/new-runtime.js'),'module.exports={};\n'),
    f=>fs.chmodSync(path.join(f.dir,'controller-entry.js'),0o755),
    f=>fs.writeFileSync(path.join(f.dir,'deployment/declared-imports.json'),'[]\n'),
    f=>fs.writeFileSync(path.join(f.dir,'deployment/archive-manifest.json'),'{broken'),
  ];
  for (const change of changes) {
    const f=packagingFixture(t);change(f);const before=f.state(),failed=f.check();
    assert.equal(failed.status,1,failed.stdout+failed.stderr);
    assert.ok(JSON.parse(failed.stdout).errors.includes('ARCHIVE_INVENTORY_STALE'));
    assert.deepEqual(f.state(),before);
    const regenerated=f.check('--write-inventory');assert.equal(regenerated.status,0,regenerated.stdout+regenerated.stderr);
    assert.equal(f.check().status,0);
  }
});
test('regeneration refuses unresolved imports, unsafe modes, symlink inventories and invalid arguments',t=>{
  for (const change of [
    f=>fs.appendFileSync(path.join(f.dir,'controller-entry.js'),"\nrequire('node:child_process');\n"),
    f=>fs.chmodSync(path.join(f.dir,'controller-entry.js'),0o600),
  ]) {
    const f=packagingFixture(t);change(f);const before=f.state(),result=f.check('--write-inventory');
    assert.equal(result.status,1,result.stdout+result.stderr);assert.deepEqual(f.state(),before);
  }
  const f=packagingFixture(t);const target=path.join(f.dir,'deployment/archive-manifest.json');
  fs.unlinkSync(target);fs.symlinkSync(path.join(root,'deployment/archive-manifest.json'),target);
  assert.equal(f.check('--write-inventory').status,1);
  assert.equal(f.check('--unexpected').status,1);
});
test('regeneration validates every destination type before changing any inventory',t=>{
  const f=packagingFixture(t);fs.appendFileSync(path.join(f.dir,'controller-entry.js'),'\n// deliberate source update\n');
  const invalid=path.join(f.dir,'deployment/declared-imports.json');fs.unlinkSync(invalid);fs.mkdirSync(invalid);
  const before=inventories.filter(name=>name!=='declared-imports.json').map(name=>[name,fs.readFileSync(path.join(f.dir,'deployment',name),'utf8')]);
  const result=f.check('--write-inventory');assert.equal(result.status,1);assert.ok(JSON.parse(result.stdout).errors.includes('ARCHIVE_INVENTORY_INVALID'));
  for(const [name,bytes] of before)assert.equal(fs.readFileSync(path.join(f.dir,'deployment',name),'utf8'),bytes);
  assert.ok(fs.statSync(invalid).isDirectory());
});
test('packaging receipt binds a clean revision to the real ZIP, tools, current locks and local-only scope',t=>{
  const f=packagingFixture(t);f.git('init','-q');f.commit();
  const oldMask=process.umask(0o077);let result;
  try { result=f.run('assemble-controller.js','dist/fresh/controller'); } finally { process.umask(oldMask); }
  assert.equal(result.status,0,result.stdout+result.stderr);
  const receipt=JSON.parse(fs.readFileSync(path.join(f.dir,'dist/fresh/controller-receipt.json')));
  assert.deepEqual(receipt.revision,{commit:f.git('rev-parse','HEAD'),tree:f.git('rev-parse','HEAD^{tree}')});
  assert.equal(receipt.archive.sha256,hash(fs.readFileSync(path.join(f.dir,'dist/fresh/controller.zip'))));
  assert.equal(receipt.archive.fileCount,JSON.parse(fs.readFileSync(path.join(f.dir,'deployment/archive-manifest.json'))).files.length);
  for (const [name,digest] of Object.entries({...receipt.lockSha256,...receipt.toolSourceSha256,...receipt.inventorySha256})) {
    assert.equal(hash(fs.readFileSync(path.join(f.dir,name))),digest);
  }
  assert.match(receipt.tools.node,/^v24\./);assert.match(receipt.tools.python,/^Python 3\./);
  assert.ok(receipt.commands.every(command=>command.exitCode===0 && command.result.ok));
  for (const [name,row] of Object.entries(receipt.sourceInputs)) {
    assert.equal(row.sha256,hash(fs.readFileSync(path.join(f.dir,name))));
    assert.equal(parseInt(row.mode,8),fs.statSync(path.join(f.dir,name)).mode&0o7777);
  }
  const contract=JSON.parse(fs.readFileSync(path.join(f.dir,'deployment/archive-source-map.json')));
  for (const [name,mode] of Object.entries(contract.modes)) assert.equal(fs.statSync(path.join(f.dir,'dist/fresh/controller',name)).mode&0o7777,parseInt(mode,8));
  execFileSync('python3',['-c','import json,stat,sys,zipfile; modes=json.load(open(sys.argv[2]))["modes"]; z=zipfile.ZipFile(sys.argv[1]); assert all(stat.S_IMODE(r.external_attr>>16)==int(modes[r.filename],8) for r in z.infolist())',path.join(f.dir,'dist/fresh/controller.zip'),path.join(f.dir,'deployment/archive-source-map.json')]);
  assert.deepEqual(receipt.qualification,{fullSourceSuiteRun:false,syntheticOrLocalOnly:true,providerCalls:false,cloudDeployed:false,liveReadiness:false});
  assert.equal(f.git('status','--porcelain'),'');
});
test('clean-status shortcuts cannot hide ignored runtime additions or uncommitted tool bytes/modes from the receipt',t=>{
  for (const kind of ['ignored-runtime','tool-bytes','tool-mode']) {
    const f=packagingFixture(t);f.git('init','-q');
    fs.appendFileSync(path.join(f.dir,'.gitignore'),'\ncloud-functions/webhook-handler/ignored.js\n');f.commit();
    if(kind==='ignored-runtime')fs.writeFileSync(path.join(f.dir,'cloud-functions/webhook-handler/ignored.js'),'module.exports={};\n');
    else if(kind==='tool-bytes') {
      f.git('update-index','--assume-unchanged','packaging/controller-zip.py');fs.appendFileSync(path.join(f.dir,'packaging/controller-zip.py'),'\n# changed tool bytes\n');
    } else {
      f.git('config','core.fileMode','false');fs.chmodSync(path.join(f.dir,'packaging/controller-zip.py'),0o755);
    }
    assert.equal(f.git('status','--porcelain'),'');
    const result=f.run('assemble-controller.js');assert.notEqual(result.status,0,result.stdout+result.stderr);
    assert.equal(fs.existsSync(path.join(f.dir,'dist/controller-receipt.json')),false);
    assert.equal(fs.existsSync(path.join(f.dir,'dist/controller')),false);
  }
});
test('a nonignored positional destination succeeds while recognizing only its exact generated files',t=>{
  const f=packagingFixture(t);f.git('init','-q');f.commit();
  const result=f.run('assemble-controller.js','artifacts/controller');assert.equal(result.status,0,result.stdout+result.stderr);
  const receipt=JSON.parse(fs.readFileSync(path.join(f.dir,'artifacts/controller-receipt.json')));
  assert.equal(receipt.revision.commit,f.git('rev-parse','HEAD'));
  const untracked=f.git('ls-files','--others','--exclude-standard').split('\n');
  const manifest=JSON.parse(fs.readFileSync(path.join(f.dir,'artifacts/controller-manifest.json')));
  assert.deepEqual(untracked.sort(),[...manifest.files.map(row=>'artifacts/controller/'+row.path),
    'artifacts/controller-manifest.json','artifacts/controller-receipt.json'].sort());
  assert.ok(fs.existsSync(path.join(f.dir,'artifacts/controller.zip'))); // *.zip stays ignored.
});
test('receipt packaging refuses dirty revisions and every existing companion output without overwriting',t=>{
  const f=packagingFixture(t);f.git('init','-q');f.commit();
  fs.appendFileSync(path.join(f.dir,'controller-entry.js'),'\n// dirty\n');
  const dirty=f.run('assemble-controller.js');assert.match(dirty.stderr,/ARCHIVE_REVISION_DIRTY/);
  assert.equal(fs.existsSync(path.join(f.dir,'dist/controller')),false);
  f.git('restore','controller-entry.js');
  for (const name of ['controller-manifest.json','controller.zip','controller-receipt.json']) {
    const parent=path.join(f.dir,'dist',name.replaceAll('.','-'));fs.mkdirSync(parent,{recursive:true});
    const file=path.join(parent,name);fs.writeFileSync(file,'operator data');
    const result=f.run('assemble-controller.js',path.join(parent,'controller'));
    assert.match(result.stderr,/ARCHIVE_DESTINATION_INVALID/);assert.equal(fs.readFileSync(file,'utf8'),'operator data');
    assert.equal(fs.existsSync(path.join(parent,'controller')),false);
  }
  const parent=path.join(f.dir,'dist/dangling');fs.mkdirSync(parent,{recursive:true});
  fs.symlinkSync(path.join(parent,'absent'),path.join(parent,'controller-receipt.json'));
  assert.match(f.run('assemble-controller.js',path.join(parent,'controller')).stderr,/ARCHIVE_DESTINATION_INVALID/);
  assert.equal(fs.existsSync(path.join(parent,'absent')),false);
});
