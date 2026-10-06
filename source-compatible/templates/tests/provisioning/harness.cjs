const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const sourceDir = path.resolve(__dirname, '../../cloud-functions/webhook-handler');

function load(options = {}, loader = null) {
  const store = new Map();
  const calls = { builds: [], secrets: [], inventory: 0 };
  const env = { GOOGLE_CLOUD_PROJECT: 'PARITY_INPUT_152', DEFAULT_ZONE: 'synthetic-zone', MAX_RUNNER_VMS: '2',
    GITHUB_REPO_OWNER: 'example', GITHUB_REPO_NAME: 'repo', CLOUDBUILD_SERVICE_ACCOUNT: 'PARITY_INPUT_338', ...options.env };
  const secret = options.secret === undefined ? 'synthetic-webhook-secret' : options.secret;
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
        const value = await fn({ get: ref => ref.get(), set: (ref, data) => writes.push([ref.key, data]) });
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
      builds.set(id, {id, status: 'WORKING'});
      if (options.missingBuildId) return [{name: 'operation-without-id'}];
      return [{name: 'operation-' + id, metadata: {build: {id}}}];
    },
    async getBuild({id}) { if (options.failBuildRead) throw Error('build lookup unavailable'); return [builds.get(id)]; },
  };
  const compute = {
    async *aggregatedListAsync() { calls.inventory++; if (options.failInventory) throw Error('inventory unavailable'); yield ['zones/synthetic-zone', {instances: [...live].map(name => ({name}))}]; },
    async get() { throw Error('not found'); },
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
  else {
    const context = {Buffer, console: {log() {}, warn() {}, error() {}}, process: {env}, Date, Math, setTimeout, __dirname: sourceDir};
    const cfg = {exports: {}};
    vm.runInNewContext(`(function(module,exports){${fs.readFileSync(path.join(sourceDir, 'infrastructure-config.js'),'utf8')}\n})`, context)(cfg, cfg.exports);
    const module = {exports: {}};
    const requireSource = name => factories[name] || (name === './infrastructure-config' ? cfg.exports : name.startsWith('./') ? require(path.join(sourceDir, name)) : require(name));
    vm.runInNewContext(`(function(require,module,exports){${fs.readFileSync(path.join(sourceDir,'index.js'),'utf8')}\n})`, context)(requireSource, module, module.exports);
    handler = module.exports;
  }
  async function request({job = 10, delivery = 'delivery', action = 'queued', labels = ['self-hosted'], owner = 'example', repo = 'repo', signature, raw = true, bodyOverride} = {}) {
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
