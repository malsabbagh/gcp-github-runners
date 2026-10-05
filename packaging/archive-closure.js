'use strict';
// Pure consistency checker for reviewed declared imports and a regular-file
// archive inventory. This does not parse/execute source, inspect ZIP bytes,
// resolve/install packages, attest reviewed input, or authorize any action.
const { createHash } = require('node:crypto');
const digest = text => createHash('sha256').update(text, 'utf8').digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
const pathOK = path => typeof path === 'string' && path.length <= 240 &&
  /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(path) &&
  path.split('/').every(part => part !== '.' && part !== '..');
function relativeTarget(from, specifier, kind) {
  const parts = from.split('/'); parts.pop();
  for (const part of specifier.split('/')) {
    if (part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else { if (!part) return null; parts.push(part); }
  }
  let target = parts.join('/');
  if (kind !== 'asset' && !/\.(?:js|json)$/.test(target)) target += '.js';
  return pathOK(target) ? target : null;
}
function externalName(specifier) {
  if (/^@[a-z0-9_-]+\/[a-z0-9._-]+(?:\/[A-Za-z0-9._/-]+)?$/.test(specifier)) return specifier.split('/').slice(0, 2).join('/');
  if (/^[a-z0-9][a-z0-9._-]*(?:\/[A-Za-z0-9._/-]+)?$/.test(specifier)) return specifier.split('/')[0];
  return null;
}
function sameMap(a, b) {
  return object(a) && object(b) && Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every(key => Object.hasOwn(b, key) && a[key] === b[key]);
}
function verifyDeclaredArchiveClosure(input) {
  const errors = new Set();
  const fail = code => errors.add(code);
  let archiveClosureConsistent = false, dependencyLockConsistent = false;
  try {
    if (!object(input)) { fail('ARCHIVE_INPUT_INVALID'); throw Error('bounded'); }
    const { manifest, files, importDescriptors, lock } = input;
    if (!exactKeys(manifest, ['version', 'profile', 'runtime', 'entry', 'rootPackage', 'packageLock', 'files']) ||
        manifest.version !== 1 || manifest.profile !== 'controller-source-archive' || manifest.runtime !== 'nodejs24' ||
        manifest.entry !== 'controller-entry.js' || manifest.rootPackage !== 'package.json' ||
        manifest.packageLock !== 'package-lock.json' || !Array.isArray(manifest.files) ||
        manifest.files.length < 3 || manifest.files.length > 100 || !Array.isArray(files) || files.length > 100 ||
        !Array.isArray(importDescriptors) || importDescriptors.length > 1000) {
      fail('ARCHIVE_INPUT_INVALID'); throw Error('bounded');
    }
    const expected = new Map(), actual = new Map(); let total = 0;
    for (const row of manifest.files) {
      if (!exactKeys(row, ['path', 'sha256']) || !pathOK(row.path) || expected.has(row.path)) {
        fail('ARCHIVE_MANIFEST_INVALID'); continue;
      }
      if (typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256)) fail('ARCHIVE_UNPINNED_FILE');
      expected.set(row.path, row.sha256);
    }
    for (const row of files) {
      if (!exactKeys(row, ['path', 'kind', 'content']) || !pathOK(row.path) || row.kind !== 'file' ||
          typeof row.content !== 'string' || row.content.length > 2097152 || actual.has(row.path)) {
        fail('ARCHIVE_FILE_INVALID'); continue;
      }
      total += row.content.length;
      if (total > 20971520) fail('ARCHIVE_SIZE_INVALID');
      actual.set(row.path, row.content);
      if (!expected.has(row.path)) fail('ARCHIVE_EXTRA_FILE');
      else if (digest(row.content) !== expected.get(row.path)) fail('ARCHIVE_HASH_MISMATCH');
    }
    for (const path of expected.keys()) if (!actual.has(path)) fail('ARCHIVE_MISSING_FILE');
    for (const path of [manifest.entry, manifest.rootPackage, manifest.packageLock])
      if (!expected.has(path)) fail('ARCHIVE_REQUIRED_FILE_UNDECLARED');
    const pkg = JSON.parse(actual.get(manifest.rootPackage));
    if (!object(pkg) || pkg.private !== true || pkg.type !== 'commonjs' || pkg.main !== manifest.entry ||
        !object(pkg.engines) || pkg.engines.node !== '24.x' || !object(pkg.dependencies) ||
        Object.hasOwn(pkg, 'workspaces') || (pkg.scripts !== undefined && (!object(pkg.scripts) || Object.keys(pkg.scripts).length))) {
      fail('ARCHIVE_PACKAGE_INVALID'); throw Error('bounded');
    }
    for (const [name, requested] of Object.entries(pkg.dependencies)) {
      if (externalName(name) !== name || typeof requested !== 'string' || !/^\d+\.\d+\.\d+$/.test(requested))
        fail('ARCHIVE_DEPENDENCY_REQUEST_INVALID');
    }
    const descriptors = new Set();
    for (const row of importDescriptors) {
      if (!exactKeys(row, ['from', 'specifier', 'kind']) || !actual.has(row.from) ||
          typeof row.specifier !== 'string' || row.specifier.length > 240 ||
          !['static', 'lazy', 'asset'].includes(row.kind)) { fail('ARCHIVE_IMPORT_INVALID'); continue; }
      const key = JSON.stringify([row.from, row.specifier, row.kind]);
      if (descriptors.has(key)) { fail('ARCHIVE_IMPORT_DUPLICATE'); continue; } descriptors.add(key);
      if (row.specifier.startsWith('./') || row.specifier.startsWith('../')) {
        const target = relativeTarget(row.from, row.specifier, row.kind);
        if (!target) fail('ARCHIVE_IMPORT_ESCAPE');
        else if (!actual.has(target)) fail('ARCHIVE_IMPORT_MISSING');
      } else if (row.kind === 'asset') fail('ARCHIVE_ASSET_INVALID');
      else if (row.specifier.startsWith('node:')) {
        if (!['node:crypto', 'node:util', 'node:buffer'].includes(row.specifier)) fail('ARCHIVE_BUILTIN_UNREVIEWED');
      } else {
        const name = externalName(row.specifier);
        if (!name || !Object.hasOwn(pkg.dependencies, name)) fail('ARCHIVE_UNDECLARED_DEPENDENCY');
      }
    }
    archiveClosureConsistent = errors.size === 0;
    const lockBytes = actual.get(manifest.packageLock);
    if (lock === undefined || lockBytes === undefined) fail('ARCHIVE_LOCK_UNRESOLVED');
    else {
      const serializedLock = JSON.parse(lockBytes);
      // The caller supplies the exact parsed lock too: no hidden old snapshot.
      if (digest(JSON.stringify(lock)) !== digest(JSON.stringify(serializedLock)) ||
          !object(lock) || lock.lockfileVersion !== 3 || !object(lock.packages) ||
          !sameMap(lock.packages['']?.dependencies, pkg.dependencies) ||
          lock.packages['']?.engines?.node !== pkg.engines.node ||
          Object.hasOwn(lock.packages[''] || {}, 'workspaces')) fail('ARCHIVE_LOCK_DECLARATIONS_MISMATCH');
      else {
        for (const [name, requested] of Object.entries(pkg.dependencies)) {
          const record = lock.packages['node_modules/' + name];
          if (!object(record) || record.version !== requested ||
              typeof record.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(record.integrity))
            fail('ARCHIVE_LOCK_DIRECT_DEPENDENCY_MISSING');
        }
        dependencyLockConsistent = errors.size === 0;
      }
    }
  } catch (_) { if (!errors.size) fail('ARCHIVE_INPUT_INVALID'); }
  return { ok: errors.size === 0, archiveClosureConsistent, dependencyLockConsistent,
    qualification: 'declared-static-consistency-only', errors: [...errors].sort() };
}
module.exports = { verifyDeclaredArchiveClosure };
