'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {createProductionDeployment,createGoogleInvocationVerifier,readReadiness}=require('../cloud-functions/webhook-handler/deployment-runtime');
const response=()=>({code:0,body:null,set(){return this;},status(n){this.code=n;return this;},json(body){this.body=body;return this;}});
const request=path=>({path,originalUrl:path,method:'POST',get:()=>null,is:()=>true,rawBody:Buffer.from('{}'),body:{}});
test('registered Node24 function target uses Functions Framework without provider initialization',()=> {
  const entry=require('../controller-entry');const {getFunction}=require('@google-cloud/functions-framework/testing');
  assert.equal(getFunction('controllerHttp'),entry.controllerHttp);
  for (const [name,exported,method] of [['@google-cloud/compute','InstancesClient','get'],['@google-cloud/cloudbuild','CloudBuildClient','createBuild'],['@google-cloud/firestore','Firestore','runTransaction'],['@google-cloud/secret-manager','SecretManagerServiceClient','accessSecretVersion']]) {
    const ctor=require(name)[exported];assert.equal(typeof ctor,'function');assert.equal(typeof ctor.prototype[method],'function');
  }
  const {Octokit}=require('@octokit/rest');const {createAppAuth}=require('@octokit/auth-app');
  const app=new Octokit({authStrategy:createAppAuth,auth:{appId:1,privateKey:'offline-unusable-key',installationId:1}});
  assert.equal(typeof app.rest.actions.generateRunnerJitconfigForRepo,'function');assert.equal(typeof app.rest.actions.listSelfHostedRunnersForRepo,'function');
});
test('all production effects are closed by default and health contains only booleans',async()=> {
  let initialized=0;const deployment=createProductionDeployment({environment:{},webhookFactory:()=>{initialized++;throw Error('must remain closed');}});
  for (const [path,code] of [['/webhook','WEBHOOK_DISABLED'],['/management/scheduled','MANAGEMENT_DISABLED'],['/bootstrap','BOOTSTRAP_UNAVAILABLE'],['/bootstrap/worker-control/poll','WORKER_CONTROL_DISABLED']]) {
    const res=response();await deployment.handle(request(path),res);assert.equal(res.code,503);assert.equal(res.body.code,code);
  }
  const res=response();await deployment.handle(request('/healthz'),res);assert.equal(res.code,200);assert.ok(Object.values(res.body.enabled).every(v=>v===false));assert.equal(initialized,0);
});
test('unknown/query routes and invalid readiness/configuration fail without leaking input',async()=> {
  assert.throws(()=>readReadiness({WEBHOOK_ENABLED:'1'}),/DEPLOYMENT_CONFIGURATION_INVALID/);
  const deployment=createProductionDeployment({environment:{WEBHOOK_ENABLED:'true'}});
  for (const req of [request('/other'),{...request('/webhook'),originalUrl:'/webhook?injected=1'},request('/webhook')]) {
    const res=response();await deployment.handle(req,res);assert.ok([400,404,503].includes(res.code));assert.equal(JSON.stringify(res.body).includes('injected'),false);
  }
});
test('Google invocation adapter delegates exact audience and does not construct client until verification',async()=> {
  let constructed=0,verified;
  class OAuth2Client {constructor(){constructed++;}async verifyIdToken(input){verified=input;return {getPayload:()=>({sub:'123456'})};}}
  const verify=createGoogleInvocationVerifier({OAuth2Client});assert.equal(constructed,0);
  assert.deepEqual(await verify('signed-token',{audience:'https://controller.example'}),{sub:'123456'});
  assert.deepEqual(verified,{idToken:'signed-token',audience:'https://controller.example'});assert.equal(constructed,1);
  await verify('again',{audience:'https://controller.example'});assert.equal(constructed,1);
});
test('Cloud Functions prefix is removed from local routes while preserving exact configured audience',async()=> {
  for (const base of ['https://controller.example','https://region-project.cloudfunctions.net/runner-controller']) {
    const deployment=createProductionDeployment({environment:{ALLOCATION_BROKER_URL:base+'/bootstrap',CONTROLLER_AUDIENCE:base}});
    const res=response();await deployment.handle(request('/bootstrap'),res);assert.equal(res.body.code,'BOOTSTRAP_UNAVAILABLE');
    const poll=response();await deployment.handle(request('/bootstrap/worker-control/poll'),poll);assert.equal(poll.body.code,'WORKER_CONTROL_DISABLED');
  }
});
test('enabled production routes compose exactly once with shared provider clients and frozen owner configuration',async()=> {
  const clients={firestore:{},compute:{},cloudBuild:{}},calls=[];
  const environment={GOOGLE_CLOUD_PROJECT:'example-project',DEFAULT_ZONE:'europe-west12-a',INSTANCE_TEMPLATE_NAME:'one-job-template',MAX_RUNNER_VMS:'2',FIRESTORE_DATABASE_ID:'runner-state',VM_CREATION_TIMEOUT_SECONDS:'600',GITHUB_WEBHOOK_SECRET_VERSION:'projects/example-project/secrets/webhook/versions/1',BUILDER_IMAGE:'gcr.io/example-project/builder@sha256:'+'a'.repeat(64),WORKER_SERVICE_ACCOUNT:'worker@example-project.iam.gserviceaccount.com',WORKER_SERVICE_ACCOUNT_UNIQUE_ID:'123456789012345678901',ALLOCATION_BROKER_URL:'https://controller.example/function/bootstrap',GITHUB_REPO_OWNER:'example',GITHUB_REPO_NAME:'repo',CLOUDBUILD_SERVICE_ACCOUNT:'provisioner@example-project.iam.gserviceaccount.com',CONTROLLER_AUDIENCE:'https://controller.example/function',ADMIN_SERVICE_ACCOUNT_UNIQUE_ID:'222222222222222222222',SCHEDULER_SERVICE_ACCOUNT_UNIQUE_ID:'333333333333333333333'};
  for(const key of ['WEBHOOK_ENABLED','MANAGEMENT_ENABLED','SCHEDULED_ENABLED','JIT_PROVIDER_LIFETIME_QUALIFIED','APPROVED_QUIESCENCE','DISPATCH_ENABLED','WORKER_DRAIN_QUALIFIED','WORKER_STOP_QUALIFIED'])environment[key]='true';
  let options,constructions=0;
  const endpoint=name=>async(req,res)=>{calls.push(name);return res.status(200).json({ok:true});};
  const deployment=createProductionDeployment({environment,clients,webhookFactory:input=>{constructions++;assert.equal(input.clients,clients);assert.equal(input.infrastructureConfig.DEFAULT_ZONE,'europe-west12-a');return {clients,registeredLabels:['self-hosted','private-one-job'],eligible:()=>true,provisioning:{},webhookHandler:endpoint('webhook')};},controllerFactory:input=>{options=input;return {handleBootstrap:endpoint('bootstrap'),handleManagement:endpoint('management')};},workerControlFactory:()=>({handle:endpoint('worker')})});
  environment.GITHUB_REPO_NAME='mutated-after-construction';
  for(const route of ['/webhook','/bootstrap','/management/scheduled','/bootstrap/worker-control/poll','/bootstrap/worker-control/ack']){const res=response();await deployment.handle(request(route),res);assert.equal(res.code,200);}
  assert.deepEqual(calls,['webhook','bootstrap','management','worker','worker']);assert.equal(constructions,1);assert.equal(options.firestore,clients.firestore);assert.equal(options.compute,clients.compute);assert.equal(options.environment.GITHUB_REPO_NAME,'repo');assert.equal(options.transportGuard({get:()=> 'Bearer '+'a'.repeat(80)}),true);assert.equal(options.transportGuard({get:()=> 'Bearer malformed'}),false);
});
test('portable configuration rejects ambient/private fallbacks and unsafe bounds and identity combinations',()=> {
  const {readInfrastructureConfiguration,validateConfiguration}=require('../cloud-functions/webhook-handler/infrastructure-config');
  const valid={GOOGLE_CLOUD_PROJECT:'example-project',DEFAULT_ZONE:'europe-west10-a',INSTANCE_TEMPLATE_NAME:'one-job-template',MAX_RUNNER_VMS:'2',FIRESTORE_DATABASE_ID:'runner-state',VM_CREATION_TIMEOUT_SECONDS:'600',GITHUB_WEBHOOK_SECRET_VERSION:'projects/example-project/secrets/webhook/versions/1',BUILDER_IMAGE:'gcr.io/example-project/builder@sha256:'+'a'.repeat(64),WORKER_SERVICE_ACCOUNT:'worker@example-project.iam.gserviceaccount.com',WORKER_SERVICE_ACCOUNT_UNIQUE_ID:'123456789012345678901',ALLOCATION_BROKER_URL:'https://controller.example/bootstrap',GITHUB_REPO_OWNER:'example',GITHUB_REPO_NAME:'repo',CLOUDBUILD_SERVICE_ACCOUNT:'provisioner@example-project.iam.gserviceaccount.com'};
  assert.equal(readInfrastructureConfiguration(valid).DEFAULT_ZONE,'europe-west10-a');
  for(const patch of [{BOOTSTRAP_TTL_MS:'0'},{BOOTSTRAP_TTL_MS:'900001'},{RECONCILIATION_BATCH_SIZE:'101'},{RECONCILIATION_BATCH_SIZE:'1.5'},{MAX_RUNNER_VMS:'0'},{DEFAULT_ZONE:'us-central1-a;anything'},{BUILDER_IMAGE:'latest'},{RUNNERS_PER_VM:'2'},{CLOUDBUILD_SERVICE_ACCOUNT:valid.WORKER_SERVICE_ACCOUNT},{GITHUB_WEBHOOK_SECRET_VERSION:'projects/other-project/secrets/webhook/versions/1'},{WORKER_SERVICE_ACCOUNT:'worker@other-project.iam.gserviceaccount.com'}]) {
    const env={...valid,...patch};assert.throws(()=>validateConfiguration(env,readInfrastructureConfiguration(env)));
  }
});
