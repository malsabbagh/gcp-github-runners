'use strict';

const assert = require('node:assert/strict');
const {test} = require('node:test');
const {spawnSync} = require('node:child_process');
const {createRequire} = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('root minimatch preserves file, dotfile, brace and partial globstar matching', () => {
  const match = require('minimatch');
  assert.equal(match('cloud-functions/webhook-handler/index.js', 'cloud-functions/**/*.js'), true);
  assert.equal(match('cloud-functions/webhook-handler/index.json', 'cloud-functions/**/*.js'), false);
  assert.equal(match('cloud-functions/.fixture.js', 'cloud-functions/**/*.js'), false);
  assert.equal(match('cloud-functions/.fixture.js', 'cloud-functions/**/*.js', {dot: true}), true);
  assert.equal(match('tests/fixture.test.js', '**/*.{test,spec}.js'), true);
  assert.equal(match('cloud-functions', 'cloud-functions/**', {partial: true}), true);
  assert.equal(match('cloud-functions/webhook-handler', 'cloud-functions/**/index.js', {partial: true}), true);
  assert.equal(match('tests/webhook-handler', 'cloud-functions/**/index.js', {partial: true}), false);
});

test('root glob and test-exclude retain production files and omit tests, dependencies and coverage', () => {
  const glob = require('glob');
  const TestExclude = require('test-exclude');
  const match = require.resolve('minimatch');
  for (const consumer of ['glob', 'test-exclude']) {
    assert.equal(createRequire(require.resolve(consumer)).resolve('minimatch'), match);
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-matching-fixture-'));
  const included = ['controller-entry.js', 'cloud-functions/handler/index.js', 'packaging/assemble.js'];
  const excluded = ['cloud-functions/handler/index.test.js', 'cloud-functions/handler/node_modules/fixture/index.js',
    'cloud-functions/handler/coverage/report.js', 'tests/fixture.test.js'];
  try {
    for (const file of [...included, ...excluded]) {
      const target = path.join(directory, file);
      fs.mkdirSync(path.dirname(target), {recursive: true});
      fs.writeFileSync(target, 'module.exports = 42;\n');
    }
    const exclude = ['**/*.test.js', '**/node_modules/**', '**/coverage/**'];
    assert.deepEqual(glob.sync('**/*.js', {cwd: directory, nodir: true, ignore: exclude}).sort(), included.sort());
    const selection = new TestExclude({cwd: directory, extension: ['.js'],
      include: ['controller-entry.js', 'cloud-functions/**/*.js', 'packaging/*.js'], exclude});
    assert.deepEqual(selection.globSync().sort(), included.sort());
    assert.equal(selection.shouldInstrument(path.resolve(directory, '..', 'outside.js')), false);
    for (const file of excluded) assert.equal(selection.shouldInstrument(path.join(directory, file)), false);
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});

test('root minimatch rejects many-globstar near-matches within a bounded child process', () => {
  const script = `const match = require('minimatch');
    const pattern = Array(12).fill('**/a').join('/') + '/b';
    const input = Array(40).fill('a').join('/') + '/c';
    if (match(input, pattern) !== false) process.exit(1);`;
  const result = spawnSync(process.execPath, ['-e', script],
    {cwd: path.resolve(__dirname, '..'), timeout: 3000, encoding: 'utf8'});
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});
