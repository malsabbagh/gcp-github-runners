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

test('ReviewSensei preserves its bounded external automation contract', () => {
  const workflow = read('.github/workflows/review-sensei-review.yml');
  assert.deepEqual(Object.keys(workflow.on).sort(),
    ['issue_comment', 'pull_request', 'pull_request_review_comment', 'workflow_dispatch']);
  assert.deepEqual(workflow.on.pull_request.types, ['opened','reopened','synchronize','ready_for_review']);
  assert.deepEqual(workflow.on.issue_comment.types, ['created']);
  assert.deepEqual(workflow.on.pull_request_review_comment.types, ['created']);
  assert.deepEqual(workflow.permissions, {contents:'read','pull-requests':'read',issues:'read','id-token':'write'});
  assert.deepEqual(Object.keys(workflow.jobs).sort(), ['resolve-trigger','review-or-reply']);
  const resolver = workflow.jobs['resolve-trigger'], runner = workflow.jobs['review-or-reply'];
  assert.equal(resolver['runs-on'], 'ubuntu-latest');
  assert.deepEqual(resolver.permissions, {contents:'read','pull-requests':'read',issues:'read'});
  const checkout = resolver.steps[0];
  assert.equal(checkout.uses, 'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683');
  assert.deepEqual(checkout.with, {'persist-credentials':false,ref:'${{ github.event.repository.default_branch }}'});
  assert.equal(fs.existsSync(path.join(__dirname,'../src/review_sensei/hosting/github/trigger.py')), false,
    'A local override would bypass the tested embedded resolver');
  assert.equal(runner.uses, 'malsabbagh/review-sensei/.github/workflows/review-sensei-run.yml@v5');
  assert.equal(runner.needs, 'resolve-trigger');
  assert.equal(runner.permissions, undefined);
  assert.equal(runner.if, undefined);
  assert.deepEqual(runner.secrets, {
    OLLAMA_API_KEY:'${{ secrets.OLLAMA_API_KEY }}',
    OPENROUTER_API_KEY:'${{ secrets.OPENROUTER_API_KEY }}',
    OPENAI_API_KEY:'${{ secrets.OPENAI_API_KEY }}',
  });
  const inputs = workflow.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs).sort(), ['operation','review_remaining','pull_request_number','head_repository',
    'source_kind','source_comment_id','source_updated_at','root_comment_id'].sort());
  assert.deepEqual(inputs.review_remaining, {description:'Continue exact retained partial coverage with one bounded window',
    required:false,default:false,type:'boolean'});
  assert.deepEqual(inputs.operation.options, ['review']);
  assert.equal(/recover_publication|recovery_policy_commit|recovery_expected_head/.test(JSON.stringify(workflow)), false);
  assert.deepEqual(Object.keys(runner.with).sort(), ['mode','operation','repository','repository_id','pull_request_number',
    'base_ref','base_sha','head_ref','head_repository','head_sha','source_kind','source_comment_id','source_updated_at',
    'root_comment_id','comment_body','comment_actor','comment_actor_type','comment_association'].sort());
  for (const field of ['operation','base_ref','base_sha','head_ref','head_sha'])
    assert.equal(runner.with[field], '${{ needs.resolve-trigger.outputs.' + field + ' }}');
  assert.equal(runner.with.repository_id, '${{ github.repository_id }}');
  const step = resolver.steps.find(s=>s.id === 'resolve');
  assert.equal(/\$\{\{/.test(step.run), false, 'Event bodies must enter through environment data');
  assert.equal(step.env.COMMENT_BODY, '${{ github.event.comment.body }}');
  const config = read('.reviewsensei.yml');
  assert.deepEqual(config, {
    schema:1, inference:{backend:'cloud-ollama',model:'deepseek-v4.1-flash:cloud'},
    github:{automatic_reviews:true,writes:true,reviews:'auto-approve',mentions:true,
      operation_entry:'enabled',learning:'disabled',artifacts:'none'},
    advanced:{endpoint:{allow_custom_endpoint:false},context:{symbol_context:{enabled:false,max_files:16,max_bytes:131072,max_depth:1}},
      egress:{allow_data_egress:false},large_changes:{orchestrate:false},resources:{timeout_seconds:900,max_provider_calls:8}},
  });
});

test('ReviewSensei event guard excludes bots, outsiders, non-PR issues and edited comments', () => {
  const workflow = read('.github/workflows/review-sensei-review.yml');
  const condition = workflow.jobs['resolve-trigger'].if;
  // Execute this checked-in expression with GitHub contains()'s case-insensitive string semantics.
  const evaluate = new Function('github', 'contains', 'return Boolean(' + condition + ');');
  for (const eventName of ['issue_comment','pull_request_review_comment'])
    for (const association of ['OWNER','MEMBER','COLLABORATOR','CONTRIBUTOR','FIRST_TIMER','NONE'])
      for (const actorType of ['User','Bot'])
        for (const action of ['created','edited','deleted'])
          for (const isPR of [true,false])
            for (const body of ['@reviewsensei verify','@ReviewSensei explain','@REVIEWSENSEI rescan','@sensei explain','ordinary text']) {
              const github = {event_name:eventName,event:{action,issue:{pull_request:isPR ? {} : null},
                comment:{body,author_association:association,user:{type:actorType}}}};
              const expected = action === 'created' && actorType === 'User' &&
                ['OWNER','MEMBER','COLLABORATOR'].includes(association) && body !== 'ordinary text' &&
                (eventName !== 'issue_comment' || isPR);
              assert.equal(evaluate(github,(a,b)=>a.toLowerCase().includes(b.toLowerCase())), expected,
                JSON.stringify({eventName,association,actorType,action,isPR,body}));
            }
  for (const eventName of ['pull_request','workflow_dispatch','push','pull_request_target','workflow_run'])
    assert.equal(evaluate({event_name:eventName,event:{}},()=>false), ['pull_request','workflow_dispatch'].includes(eventName));
});
