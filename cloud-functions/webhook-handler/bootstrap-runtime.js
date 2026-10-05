'use strict';
const { BootstrapDenied, createAllocationBootstrapStore } = require('./allocation-bootstrap-store');
const { createGoogleManagedInstanceVerifier } = require('./managed-instance-verifier');
const { createGitHubAppRunnerAdapter, createSecretManagerPrivateKeyProvider } = require('./github-app-runner-adapter');
const { createAllocationBootstrapBroker } = require('./allocation-bootstrap-broker');
const { createBootstrapHttpHandler } = require('./bootstrap-http');

function readBootstrapConfiguration(env) {
  const integer = name => {
    const raw = env[name];
    if (typeof raw !== 'string' || !/^[1-9][0-9]{0,15}$/.test(raw) || !Number.isSafeInteger(Number(raw)))
      throw new BootstrapDenied('BOOTSTRAP_INVALID');
    return Number(raw);
  };
  const privateKeyVersion = env.GITHUB_APP_PRIVATE_KEY_VERSION;
  if (typeof privateKeyVersion !== 'string' ||
      !/^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/secrets\/[A-Za-z0-9_-]{1,255}\/versions\/[1-9][0-9]{0,17}$/.test(privateKeyVersion))
    throw new BootstrapDenied('BOOTSTRAP_INVALID');
  const release = integer('JIT_RELEASE_WINDOW_MS');
  if (release < 1000 || release > 600000) throw new BootstrapDenied('BOOTSTRAP_INVALID');
  return Object.freeze({ appId: integer('GITHUB_APP_ID'),
    installationId: integer('GITHUB_APP_INSTALLATION_ID'), repositoryId: integer('GITHUB_REPOSITORY_ID'),
    runnerGroupId: integer('RUNNER_GROUP_ID'), privateKeyVersion, jitReleaseWindowMs: release });
}

// Actual composition seam. Source-core supplies its SAME Firestore client,
// validated canonical labels and repository inputs; no second database/store.
// Creating the exported handler does not load SDKs, retrieve secrets or call APIs.
function createBootstrapRuntime({ infrastructureConfig, firestore,
  repositoryOwner, repositoryName, registeredLabels, routingLabel, appConfig,
  transportGuard = () => false, jitProviderLifetimeQualified = false }) {
  let initialized;
  async function build() {
    if (initialized) return initialized;
    initialized = (async () => {
      const cfg = infrastructureConfig;
      if (!cfg || !firestore || !appConfig || typeof cfg.ALLOCATION_BROKER_URL !== 'string' ||
          typeof cfg.FIRESTORE_DATABASE_ID !== 'string' ||
          typeof cfg.WORKER_SERVICE_ACCOUNT_UNIQUE_ID !== 'string') throw new BootstrapDenied('BOOTSTRAP_INVALID');
      const url = new URL(cfg.ALLOCATION_BROKER_URL);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
        throw new BootstrapDenied('BOOTSTRAP_INVALID');
      const store = createAllocationBootstrapStore({ firestore, project: cfg.PROJECT_ID,
        zone: cfg.DEFAULT_ZONE, repositoryOwner, repositoryName,
        workerServiceAccountEmail: cfg.WORKER_SERVICE_ACCOUNT,
        workerServiceAccountUniqueId: cfg.WORKER_SERVICE_ACCOUNT_UNIQUE_ID,
        registeredLabels, routingLabel });
      const verifyIdentity = createGoogleManagedInstanceVerifier({ audience: cfg.ALLOCATION_BROKER_URL });
      let app;
      const getApp = () => {
        if (!app) app = (async () => {
          const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
          const privateKeyProvider = createSecretManagerPrivateKeyProvider({
            secretVersion: appConfig.privateKeyVersion, secretManagerClient: new SecretManagerServiceClient() });
          return createGitHubAppRunnerAdapter({ ...appConfig, repositoryOwner,
            repositoryName, privateKeyProvider });
        })();
        return app;
      };
      // This is called only after durable claim. Readiness never retrieves a key.
      const github = { async mintJit(input) { return (await getApp()).mintJit(input); } };
      const broker = createAllocationBootstrapBroker({ store, verifyIdentity, github,
        jitProviderLifetimeQualified });
      return { broker, handler: createBootstrapHttpHandler({ broker, transportGuard }) };
    })();
    return initialized;
  }
  return {
    async handle(req, res) {
      try {
        if (!await transportGuard(req)) return res.status(403).json({ ok: false, code: 'BOOTSTRAP_IDENTITY_REJECTED' });
        if (jitProviderLifetimeQualified !== true)
          return res.status(503).json({ ok: false, code: 'BOOTSTRAP_UNAVAILABLE' });
        return (await build()).handler(req, res);
      } catch (_) { return res.status(503).json({ ok: false, code: 'BOOTSTRAP_UNAVAILABLE' }); }
    }
  };
}
module.exports = { readBootstrapConfiguration, createBootstrapRuntime };
