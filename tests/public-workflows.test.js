'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const yaml = require('js-yaml');
const read = name => yaml.safeLoad(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'));

test('public validation and examples run contributed code only on hosted read-only jobs', () => {
  for (const name of ['.github/workflows/ci.yml', '.github/workflows/source-compatible-ci.yml',
    'source-compatible/templates/examples/github-workflow.yml', 'source-compatible/templates/examples/workflow-with-cleanup.yml']) {
    const workflow = read(name);
    assert.ok(workflow.on.pull_request, name);
    assert.equal(workflow.on.pull_request_target, undefined);
    assert.deepEqual(workflow.permissions, {contents:'read'});
    for (const [id, job] of Object.entries(workflow.jobs)) {
      if (id === 'publish-coverage') continue;
      assert.equal(job['runs-on'], 'ubuntu-24.04', name + ':' + id);
      assert.ok(!job.permissions || Object.values(job.permissions).every(v=>v==='read'));
      const encoded = JSON.stringify(job);
      assert.equal(/secrets\.|id-token|gcloud|\/metadata|pull_request_target/.test(encoded), false, name);
      for (const step of job.steps || []) {
        if ((step.uses || '').startsWith('actions/checkout@')) assert.equal(step.with['persist-credentials'], false);
        if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/);
        assert.equal(/\$\{\{\s*github\.event\.(?:pull_request|comment)\./.test(step.run || ''), false);
      }
    }
  }
});

test('coverage publication accepts only successful trusted-main push artifacts from the same run', () => {
  const workflow = read('.github/workflows/source-compatible-ci.yml'), job = workflow.jobs['publish-coverage'];
  assert.ok(job);
  assert.equal(job.needs, 'source');
  assert.deepEqual(job.permissions, {contents:'write'});
  const condition = job.if.replace(/\$\{\{|\}\}/g, '').trim();
  function admitted(event, ref, success) {
    return success && condition.split('&&').every(clause => {
      const m = clause.trim().match(/^github\.(event_name|ref) == '([^']+)'$/);
      assert.ok(m, 'Publisher conditions require an explicit audited scope');
      return ({event_name:event,ref})[m[1]] === m[2];
    });
  }
  for (const [event,ref,success,expected] of [['pull_request','refs/pull/1/merge',true,false],
    ['pull_request','refs/heads/main',true,false],['push','refs/heads/develop',true,false],
    ['push','refs/heads/main',false,false],['workflow_dispatch','refs/heads/main',true,false],['push','refs/heads/main',true,true]])
    assert.equal(admitted(event,ref,success), expected);
  const download = job.steps.find(s=>(s.uses || '').startsWith('actions/download-artifact@'));
  assert.ok(download);
  assert.equal(download.with['run-id'], undefined);
  assert.equal(download.with['github-token'], undefined);
  assert.equal(job.steps.some(s=>s.run), false, 'Downloaded reports must never be executed');
});

test('a malicious PR title remains data in the hosted example', () => {
  const workflow = read('source-compatible/templates/examples/github-workflow.yml');
  const step = workflow.jobs.test.steps.find(s=>s.env && s.env.PR_TITLE);
  assert.ok(step);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-title-'));
  try {
    const title = '$(touch injected); `touch injected`; "quoted"\nnext line';
    const output = execFileSync('bash', ['-eu', '-c', step.run], {cwd:directory,env:{PATH:process.env.PATH,PR_TITLE:title},encoding:'utf8'});
    assert.ok(output.includes(title));
    assert.equal(fs.existsSync(path.join(directory, 'injected')), false);
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
});
