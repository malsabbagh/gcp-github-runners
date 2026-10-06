'use strict';
// Convert each execution context to source locations before merging. Raw V8
// ranges from Jest's VM wrapper and Node's module wrapper have different offsets.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createCoverageMap } = require('istanbul-lib-coverage');
const { createContext } = require('istanbul-lib-report');
const reports = require('istanbul-reports');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--check') || args.length > 1) {
  console.error('Usage: node scripts/test-coverage.cjs [--check]');
  process.exit(2);
}
if (Number(process.versions.node.split('.')[0]) !== 24) {
  console.error('Coverage qualification requires the supported Node 24 runtime.');
  process.exit(2);
}
const output = path.join(root, 'coverage');
fs.rmSync(output, { recursive: true, force: true });
const raw = path.join(output, 'v8-node');
fs.mkdirSync(raw, { recursive: true });
const baseEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
delete baseEnv.NODE_V8_COVERAGE;
const nodeEnv = { ...baseEnv, NODE_V8_COVERAGE: raw };
let failed = false;
function run(command, argv, cwd = root, env = baseEnv) {
  const result = spawnSync(command, argv, { cwd, stdio: 'inherit', env });
  if (result.error) console.error('Coverage suite could not start:', result.error.message);
  if (result.error || result.status !== 0) failed = true;
}
const fixtures = fs.readdirSync(path.join(root, 'tests'))
  .filter(name => name.endsWith('.test.js')).sort().map(name => `tests/${name}`);
run(process.execPath, ['--test', ...fixtures], root, nodeEnv);
run('python3', ['scripts/test-python.py'], root, nodeEnv);
const nodeReport = path.join(output, 'node');
run(process.execPath, [require.resolve('c8/bin/c8.js'), 'report', '--all', '--include=controller-entry.js',
  '--include=cloud-functions/**/*.js', '--include=packaging/*.js',
  '--exclude=**/*.test.js', '--exclude=**/node_modules/**', '--exclude=**/coverage/**',
  '--reporter=json', `--reports-dir=${nodeReport}`, `--temp-directory=${raw}`]);
const maps = [path.join(nodeReport, 'coverage-final.json')];
for (const workspace of ['webhook-handler', 'cleanup-function']) {
  const directory = path.join(output, `jest-${workspace}`);
  run(process.execPath, [require.resolve('jest/bin/jest'), '--runInBand', '--coverage',
    '--coverageProvider=v8', '--coverageReporters=json', `--coverageDirectory=${directory}`,
    '--collectCoverageFrom=*.js', '--collectCoverageFrom=!*.test.js',
    '--collectCoverageFrom=!test-*.js'], path.join(root, 'cloud-functions', workspace));
  maps.push(path.join(directory, 'coverage-final.json'));
}
const coverage = createCoverageMap({});
for (const file of maps) {
  if (!fs.existsSync(file)) { console.error(`Missing coverage report: ${file}`); failed = true; continue; }
  coverage.merge(JSON.parse(fs.readFileSync(file, 'utf8')));
}
// Scope is the complete production JavaScript inventory, not just loaded files.
const production = [path.join(root, 'controller-entry.js')];
for (const relative of ['cloud-functions', 'packaging']) {
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (['node_modules', 'coverage', '__tests__'].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.endsWith('.test.js') && !entry.name.startsWith('test-')) production.push(file);
    }
  }
  visit(path.join(root, relative));
}
const expected = new Set(production);
coverage.filter(file => expected.has(path.resolve(file)));
for (const file of production) {
  if (!coverage.files().includes(file)) { console.error(`Unreported production file: ${path.relative(root, file)}`); failed = true; }
}
const context = createContext({ dir: output, coverageMap: coverage });
for (const name of ['text', 'json', 'json-summary', 'lcovonly']) reports.create(name).execute(context);
if (args.includes('--check')) {
  for (const file of coverage.files()) {
    const metrics = coverage.fileCoverageFor(file).toSummary();
    for (const metric of ['lines', 'branches', 'functions', 'statements']) {
      if (metrics[metric].pct < 81) {
        console.error(`${path.relative(root, file)} ${metric}: ${metrics[metric].pct}% < 81%`);
        failed = true;
      }
    }
  }
}
process.exit(failed ? 1 : 0);
