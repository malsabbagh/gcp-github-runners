'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createRequire}=require('node:module');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const crypto=require('node:crypto');
if(!process.env.CONTROLLER_QUALIFICATION_DIR)throw Error('STANDALONE_STAGE_REQUIRED');
const directory=fs.realpathSync(process.env.CONTROLLER_QUALIFICATION_DIR);
const staged=createRequire(path.join(directory,'package.json'));

test('each direct runtime dependency resolves inside the independent standalone installation',()=>{
  const manifest=staged('./package.json');
  assert.equal(manifest.type,'commonjs');assert.equal(manifest.engines.node,'24.x');
  assert.equal(manifest.workspaces,undefined);
  for(const name of Object.keys(manifest.dependencies)) {
    const resolved=fs.realpathSync(staged.resolve(name));
    assert.ok(resolved.startsWith(path.join(directory,'node_modules')+path.sep),name+' resolved outside the standalone installation');
  }
});
test('actual standalone SDK APIs and framework target load without credentials or provider operations',()=>{
  for(const [name,exported,method] of [
    ['@google-cloud/compute','InstancesClient','get'],['@google-cloud/cloudbuild','CloudBuildClient','createBuild'],
    ['@google-cloud/firestore','Firestore','runTransaction'],['@google-cloud/secret-manager','SecretManagerServiceClient','accessSecretVersion'],
    ['google-auth-library','OAuth2Client','verifyIdToken'],
  ])assert.equal(typeof staged(name)[exported].prototype[method],'function');
  const {Octokit}=staged('@octokit/rest'),{createAppAuth}=staged('@octokit/auth-app');
  const client=new Octokit({authStrategy:createAppAuth,auth:{appId:1,installationId:1,privateKey:'offline-unusable-key'}});
  assert.equal(typeof client.rest.actions.generateRunnerJitconfigForRepo,'function');
  assert.equal(typeof client.rest.actions.listSelfHostedRunnersForRepo,'function');
  const entry=staged('./controller-entry.js');
  assert.equal(staged('@google-cloud/functions-framework/testing').getFunction('controllerHttp'),entry.controllerHttp);
  for(const filename of Object.keys(require.cache).filter(name=>name.includes(path.sep+'node_modules'+path.sep))) {
    assert.ok(filename.startsWith(path.join(directory,'node_modules')+path.sep),'borrowed module: '+filename);
  }
});
test('standalone production routes remain closed with an empty configuration',async()=>{
  const {createProductionDeployment}=staged('./cloud-functions/webhook-handler/deployment-runtime.js');
  const deployment=createProductionDeployment({environment:{}});
  const response=()=>({code:0,body:null,set(){return this;},status(code){this.code=code;return this;},json(body){this.body=body;return this;}});
  const request=route=>({path:route,originalUrl:route,method:'POST',get:()=>null,is:()=>true,rawBody:Buffer.from('{}'),body:{}});
  for(const route of ['/webhook','/management/scheduled','/bootstrap','/bootstrap/worker-control/poll']) {
    const res=response();await deployment.handle(request(route),res);assert.equal(res.code,503);
  }
  const res=response();await deployment.handle(request('/healthz'),res);assert.equal(res.code,200);
  assert.ok(Object.values(res.body.enabled).every(value=>value===false));
});

test('standalone framework preserves normal raw JSON bytes and signature decisions over HTTP', {timeout: 10000}, async t => {
  const framework = fs.realpathSync(staged.resolve('@google-cloud/functions-framework'));
  assert.ok(framework.startsWith(path.join(directory, 'node_modules') + path.sep));
  const {getServer} = staged(path.join(path.dirname(framework), 'server.js'));
  const key = 'synthetic-standalone-http-test-key';
  const sign = body => crypto.createHmac('sha256', key).update(body).digest('hex');
  const server = getServer((req, res) => {
    assert.ok(Buffer.isBuffer(req.rawBody));
    if (sign(req.rawBody) !== req.headers['x-fixture-signature']) return res.status(401).end();
    res.json({raw: req.rawBody.toString('hex'), body: req.body});
  }, {signatureType: 'http', ignoredRoutes: null, timeoutMilliseconds: 5000});
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const request = (body, signature) => new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port: server.address().port,
      path: '/fixture', method: 'POST', headers: {'content-type': 'application/json',
        'content-length': body.length, 'x-fixture-signature': signature}}, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({status: res.statusCode, body: Buffer.concat(chunks).toString()}));
    });
    req.setTimeout(3000, () => req.destroy(Error('FIXTURE_REQUEST_TIMEOUT')));
    req.on('error', reject);
    req.end(body);
  });
  const body = Buffer.from('{ "message": "caf\u00e9", "values": [1, 2] }');
  const value = {message: 'caf\u00e9', values: [1, 2]};
  const result = await request(body, sign(body));
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body), {raw: body.toString('hex'), body: value});
  assert.equal((await request(body, sign(Buffer.from(JSON.stringify(value))))).status, 401);
  assert.equal((await request(body, 'invalid-fixture-signature')).status, 401);
});
