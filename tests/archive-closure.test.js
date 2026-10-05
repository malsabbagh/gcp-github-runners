'use strict';
// Prepared injected, source-only fixtures. No filesystem/network/process/SDKs.
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
test('unreviewed process/network/filesystem builtins cannot silently enter declared closure', () => {
  for (const specifier of ['node:fs', 'node:http', 'node:child_process']) {
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
