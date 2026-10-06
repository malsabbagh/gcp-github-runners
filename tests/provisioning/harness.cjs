const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const sourceDir = path.resolve(__dirname, '../../cloud-functions/webhook-handler');

function load(options = {}, loader = null) {
  const store = new Map();
  const calls = { builds: [], secrets: [], inventory: 0 };
  const env = { GOOGLE_CLOUD_PROJECT: 'example-project', DEFAULT_ZONE: 'us-central1-a', MAX_RUNNER_VMS: '2',
    GITHUB_REPO_OWNER: 'example', GITHUB_REPO_NAME: 'repo', CLOUDBUILD_SERVICE_ACCOUNT: 'provisioner@example-project.iam.gserviceaccount.com',
    RUNNER_LABELS_JSON: JSON.stringify(['self-hosted','trusted-private-one-job']), RUNNER_ROUTING_LABEL: 'trusted-private-one-job',
    REQUIRED_RUNNER_LABELS: JSON.stringify(['self-hosted','trusted-private-one-job']), INSTANCE_TEMPLATE_NAME: 'one-job-template', FIRESTORE_DATABASE_ID: 'autoscaler-state',
    VM_CREATION_TIMEOUT_SECONDS: '600', GITHUB_WEBHOOK_SECRET_VERSION: 'projects/example-project/secrets/github-webhook-secret/versions/1',
    WORKER_SERVICE_ACCOUNT: 'worker@example-project.iam.gserviceaccount.com', WORKER_SERVICE_ACCOUNT_UNIQUE_ID: '123456789012345678901',
    ALLOCATION_BROKER_URL: 'https://broker.example.invalid', BUILDER_IMAGE: 'gcr.io/example-project/builder@sha256:'+'a'.repeat(64), ...options.env };
  const secret = (options.secret) === undefined ? 'synthetic-webhook-secret' : (options.secret);
  let queue = Promise.resolve();
  const firestore = {
    collection(collection) { return { doc(id) {
      const key = collection + '/' + id;
      return { key, async get() { if (options.failStore) throw Error('store unavailable'); const data = store.get(key); return {exists: data !== undefined, data: () => data}; },
        async set(data) { store.set(key, data); } };
    } }; },
    runTransaction(fn) {
      const pending = queue.then(async () => {
        const writes = [];
        const value = await fn({ get: ref => ref.get(), set: (ref, data,opts) => writes.push([ref.key, opts?.merge ? {...store.get(ref.key),...data}:data]), update: (ref,data)=>writes.push([ref.key,{...store.get(ref.key),...data}]) });
        writes.forEach(([key, data]) => store.set(key, data));
        return value;
      });
      queue = pending.catch(() => {});
      return pending;
    },
  };
  const live = new Set(options.live || []);
  const builds = new Map();
  const cloudBuild = {
    async createBuild(request) {
      calls.builds.push(request);
      if (options.failSubmission) { const error = Error('submission rejected'); error.code = options.failSubmission; throw error; }
      const id = 'build-' + calls.builds.length;
      builds.set(id, {id,projectId:env.GOOGLE_CLOUD_PROJECT,status: 'WORKING'});
      if (options.missingBuildId) return [{name: 'operation-without-id'}];
      return [{name: 'operation-' + id, metadata: {build: {id}}}];
    },
    async getBuild({id}) { if (options.failBuildRead) throw Error('build lookup unavailable'); return [builds.get(id)]; },
  };
  const compute = {
    async *aggregatedListAsync() { calls.inventory++; if (options.failInventory) throw Error('inventory unavailable'); yield ['zones/us-central1-a', {instances: [...live].map(name => ({name}))}]; },
    async get({instance}) {
      if(options.failExactGet) throw Error('inspection unavailable');
      if(!live.has(instance)) throw Object.assign(Error('not found'),{code:5});
      const entries=JSON.parse(store.get('provisioning_pools/global')?.entries || '{}');
      const [key,entry]=Object.entries(entries).find(([,e])=>e.name===instance)||[];
      if(!entry) return [{name:instance}];
      const event=JSON.parse(store.get('job_provisioning/'+key).event),created=entry.bootstrapExpiresAtMs-600000;
      const base='https://www.googleapis.com/compute/v1/projects/'+env.GOOGLE_CLOUD_PROJECT+'/zones/'+env.DEFAULT_ZONE;
      const meta={'allocation-key':key,'reservation-token':entry.token,'repo-owner':event.repo_owner,'repo-name':event.repo_name,'run-id':String(event.run_id),'job-id':String(event.job_id),'run-attempt':String(event.run_attempt||1),'vm-id':instance,'allocation-broker-url':env.ALLOCATION_BROKER_URL,'runner-count':'1','worker-profile':'trusted-private-one-job','bootstrap-expires-at-ms':String(created+600000)};
      return [{name:instance,id:'123456',status:'RUNNING',creationTimestamp:new Date(created).toISOString(),zone:base,selfLink:base+'/instances/'+instance,scheduling:{provisioningModel:'SPOT',instanceTerminationAction:'DELETE',automaticRestart:false},serviceAccounts:[{email:env.WORKER_SERVICE_ACCOUNT,scopes:[]}],networkInterfaces:[{networkIP:'10.0.0.2',network:'private-network',subnetwork:'private-subnet',accessConfigs:[]}],metadata:{items:Object.entries(meta).map(([key,value])=>({key,value}))}}];
    },
  };
  const factories = {
    '@google-cloud/cloudbuild': {CloudBuildClient: function() {return cloudBuild;}},
    '@google-cloud/compute': {InstancesClient: function() {return compute;}},
    '@google-cloud/firestore': {Firestore: function() {return firestore;}},
    '@google-cloud/secret-manager': {SecretManagerServiceClient: function() {return {async accessSecretVersion(req) { calls.secrets.push(req.name); if (options.failSecret) throw Error('secret unavailable'); return [{payload: {data: Buffer.from(secret)}}]; }};}},
    '@octokit/rest': {Octokit: function() {return {rest: {actions: {}}};}},
    '@google-cloud/functions-framework': {http() {}},
  };
  let handler;
  if (loader) handler = loader({env, factories});
  else handler=require(path.join(sourceDir,'webhook-runtime')).createWebhookRuntime({environment:env,clients:{firestore,cloudBuild,compute,secretManager:new factories['@google-cloud/secret-manager'].SecretManagerServiceClient()}});

  async function request({job = 10, delivery = 'delivery', action = 'queued', labels = ['self-hosted','trusted-private-one-job'], owner = 'example', repo = 'repo', signature, raw = true, bodyOverride} = {}) {
    const body = {action, workflow_job: {id: job, run_id: 20, run_attempt: 1, labels, head_branch: 'main'}, repository: {owner: {login: owner}, name: repo}};
    const bytes = Buffer.from(JSON.stringify(body));
    const headers = {'x-github-event': 'workflow_job', 'x-github-delivery': delivery,
      'x-hub-signature-256': signature === undefined ? 'sha256=' + crypto.createHmac('sha256', secret).update(bytes).digest('hex') : signature};
    const req = {method:'POST', headers, body: bodyOverride || body};
    if (raw) req.rawBody = bytes;
    const response = {statusCode: undefined, body: undefined, status(n) {this.statusCode = n;return this;},send(t) {this.body = t;return this;}};
    await handler.webhookHandler(req,response);
    return response;
  }
  return {handler, options, calls, store, live, builds, request, pool: () => JSON.parse(store.get('provisioning_pools/global')?.entries || '{}'), jobs: () => [...store].filter(([key])=>key.startsWith('job_provisioning/')).map(([,job])=>job)};
}
module.exports = {load};
