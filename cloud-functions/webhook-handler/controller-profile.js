'use strict';
const { readBootstrapConfiguration, createBootstrapRuntime } = require('./bootstrap-runtime');
const { createGitHubAppRunnerAdapter, createSecretManagerPrivateKeyProvider } = require('./github-app-runner-adapter');
const { createRetirementController } = require('../cleanup-function/retirement-controller');
const { createActualJobAssociation } = require('./actual-job-association');
const { createAllocationRecovery } = require('./allocation-recovery');
const { createLifecycleDispatcher } = require('../cleanup-function/lifecycle-dispatcher');
const { createScheduledRecovery } = require('./scheduled-recovery');

// Source-only composition for the management identity. The caller supplies the
// controller's existing clients and canonical labels; no parallel state store.
// Real deployment, SDK and worker protocol qualification remain separate.
function createControllerProfile({ infrastructureConfig, firestore, compute, cloudBuild,
  environment, registeredLabels, transportGuard = () => false,
  jitProviderLifetimeQualified = false, approvedQuiescence = false,
  runnerAdapter: injectedRunnerAdapter, workerControl,
  dispatchEnabled = false, workerDrainQualified = false, workerStopQualified = false,
  provisioning,isEligible,scheduledEnabled = false, authenticateInvocation = async () => null,
  expectedAudience, expectedCallerSubject, adminSubject = expectedCallerSubject, schedulerSubject }) {
  const appConfig = readBootstrapConfiguration(environment);
  const repositoryOwner = environment.GITHUB_REPO_OWNER;
  const repositoryName = environment.GITHUB_REPO_NAME;
  if (!repositoryOwner || !repositoryName ||
      !appConfig.privateKeyVersion.startsWith(`projects/${infrastructureConfig.PROJECT_ID}/`)) {
    throw new Error('CONTROLLER_PROFILE_INVALID');
  }
  const bootstrap = createBootstrapRuntime({ infrastructureConfig, firestore,
    repositoryOwner, repositoryName, registeredLabels,
    routingLabel: environment.RUNNER_ROUTING_LABEL, appConfig,
    transportGuard, jitProviderLifetimeQualified });
  let adapter;
  const getAdapter = () => {
    if (!adapter) adapter = (async () => {
      const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
      const privateKeyProvider = createSecretManagerPrivateKeyProvider({
        secretVersion: appConfig.privateKeyVersion,
        secretManagerClient: new SecretManagerServiceClient() });
      return createGitHubAppRunnerAdapter({ ...appConfig, repositoryOwner,
        repositoryName, privateKeyProvider });
    })();
    return adapter;
  };
  const runnerAdapter = injectedRunnerAdapter || {
    async inspectOwnedRunner(input) { return (await getAdapter()).inspectOwnedRunner(input); },
    async listRunnerPage(input) { return (await getAdapter()).listRunnerPage(input); },
    async deregisterOwnedRunner(input) { return (await getAdapter()).deregisterOwnedRunner(input); }
  };
  const retirement = createRetirementController({ firestore, compute, runnerAdapter,
    projectId: infrastructureConfig.PROJECT_ID, repositoryOwner, repositoryName,
    approvedQuiescence,workerStopQualified });
  const association = createActualJobAssociation({ firestore, repositoryOwner, repositoryName });
  const recovery = createAllocationRecovery({ firestore, compute, cloudBuild,
    project: infrastructureConfig.PROJECT_ID, zone: infrastructureConfig.DEFAULT_ZONE,
    repositoryOwner, repositoryName,
    workerServiceAccountEmail: infrastructureConfig.WORKER_SERVICE_ACCOUNT,
    workerServiceAccountUniqueId: infrastructureConfig.WORKER_SERVICE_ACCOUNT_UNIQUE_ID,
    brokerUrl: infrastructureConfig.ALLOCATION_BROKER_URL,
    bootstrapTTLms: infrastructureConfig.BOOTSTRAP_TTL_MS,
    registeredLabels, routingLabel: environment.RUNNER_ROUTING_LABEL });
  const dispatcher = createLifecycleDispatcher({firestore, compute, runnerAdapter, workerControl,
    projectId: infrastructureConfig.PROJECT_ID, repositoryOwner, repositoryName,
    dispatchEnabled, workerDrainQualified, workerStopQualified, approvedQuiescence});
  const waitingRecovery = require('./waiting-recovery').createWaitingRecovery({firestore,provisioning,isEligible,batchSize:infrastructureConfig.RECONCILIATION_BATCH_SIZE});
  const scheduler = createScheduledRecovery({firestore, recovery, retirement, dispatcher,waitingRecovery,
    enabled: scheduledEnabled, batchSize: infrastructureConfig.RECONCILIATION_BATCH_SIZE,
    authenticateInvocation, expectedAudience, expectedCallerSubject, adminSubject, schedulerSubject});
  return Object.freeze({ bootstrap, retirement, association, recovery, dispatcher, scheduler });
}
module.exports = { createControllerProfile };
