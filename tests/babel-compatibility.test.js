'use strict';

const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {pathToFileURL} = require('node:url');
const babel = require('@babel/core');

test('Babel transforms scoped bindings without changing execution and retains source locations', () => {
  const source = 'function fixture(value) {\n  const result = value + 1;\n  if (result < 0) throw new Error("fixture rejection");\n  return result;\n}\nfixture(41);';
  const output = babel.transformSync(source, {filename: '/fixture/input.js', configFile: false,
    babelrc: false, sourceMaps: true, plugins: [({types}) => ({visitor: {
      FunctionDeclaration(node) {
        if (types.isIdentifier(node.node.id, {name: 'fixture'})) node.scope.parent.rename('fixture', 'renamed');
      }
    }})]});
  assert.equal(vm.runInNewContext(output.code), 42);
  assert.ok(output.code.includes('function renamed'));
  assert.throws(() => vm.runInNewContext(output.code.replace('renamed(41)', 'renamed(-2)')), /fixture rejection/);
  const lines = output.code.split('\n');
  const line = lines.findIndex(value => value.includes('throw new Error'));
  const column = lines[line].indexOf('throw');
  const {TraceMap, originalPositionFor} = require('@jridgewell/trace-mapping');
  const original = originalPositionFor(new TraceMap(output.map), {line: line + 1, column});
  assert.equal(original.line, 3);
  assert.equal(original.source, 'input.js');
  assert.deepEqual(output.map.sourcesContent, [source]);
});

test('Babel parser supports JSX and reports invalid syntax; Jest transformation stays usable', () => {
  const parsed = babel.parseSync('const view = <Fixture value={42} />;',
    {configFile: false, babelrc: false, parserOpts: {plugins: ['jsx']}});
  assert.equal(parsed.program.body[0].declarations[0].init.type, 'JSXElement');
  assert.throws(() => babel.parseSync('const value = ;', {configFile: false, babelrc: false}), SyntaxError);
  const transformer = require('babel-jest').createTransformer({configFile: false, babelrc: false});
  const code = transformer.process('const fixture = () => 42; fixture();', '/fixture/jest.js',
    {config: {cwd: process.cwd(), rootDir: process.cwd()}, configString: '{}', instrument: false,
      supportsDynamicImport: false, supportsExportNamespaceFrom: false, supportsStaticESM: false,
      supportsTopLevelAwait: false}).code;
  assert.equal(vm.runInNewContext(code), 42);
});

test('runtime package discovery preserves valid metadata and actionable JSON code frames', async () => {
  const {readPackageUp} = await import(pathToFileURL(require.resolve('read-package-up')).href);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-package-metadata-'));
  const packageFile = path.join(directory, 'package.json');
  try {
    fs.writeFileSync(packageFile, '{"name":"fixture-only","version":"1.0.0"}\n');
    const metadata = await readPackageUp({cwd: directory, normalize: false});
    assert.equal(metadata.packageJson.name, 'fixture-only');
    assert.equal(metadata.path, packageFile);
    fs.writeFileSync(packageFile, '{\n  "name": "fixture-only",\n  invalid\n}\n');
    await assert.rejects(readPackageUp({cwd: directory}), error => error.name === 'JSONError' &&
      error.message.includes('invalid') &&
      error.rawCodeFrame.includes('> 3 |') && error.rawCodeFrame.includes('^'));
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});
