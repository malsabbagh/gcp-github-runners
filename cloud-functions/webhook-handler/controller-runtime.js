'use strict';
const {createControllerProfile} = require('./controller-profile');
const {createManagementHttpHandler, authorityConfiguration, principalRole} = require('./management-http');
const {createInvocationAuthenticator} = require('./invocation-auth');
const {createBootstrapRuntime} = require('./bootstrap-runtime');

// Pure deployment composition. Configuration/options are owner-supplied, never
// copied from HTTP input. No clients, credentials, servers or SDKs are created.
function createControllerRuntime(suppliedOptions = {}) {
  const options = {...suppliedOptions};
  const authenticateInvocation = options.authenticateInvocation || createInvocationAuthenticator({
    verifyToken: options.invocationVerifier, verifierQualified: options.invocationVerifierQualified === true,
    audience: options.expectedAudience, adminSubject: options.adminSubject || options.expectedCallerSubject,
    schedulerSubject: options.schedulerSubject, clock: options.invocationClock,
    maximumLifetimeSeconds: options.invocationMaximumLifetimeSeconds});
  const profileFactory = options.profileFactory || createControllerProfile;
  let profile;
  const getProfile = () => {
    if (!profile) profile = profileFactory({...options, authenticateInvocation});
    return profile;
  };
  const controller = {
    requestDrain: request => getProfile().retirement.requestDrain(request),
    prepareStop: request => getProfile().retirement.prepareStop(request),
    dispatchIntent: request => getProfile().dispatcher.dispatchIntent(request),
    retireAllocation: request => getProfile().retirement.retireAllocation(request),
    reconcileOrphan: request => getProfile().retirement.reconcileOrphan(request),
    async recover(request) {
      const recovery = getProfile().recovery;
      const outcome = await recovery.hydrateAllocation(request.key, request);
      return outcome?.status === 'absent' ? recovery.recoverAbsentAllocation(request.key, request) : outcome;
    },
    // Endpoint validates caller before this lazy construction; scheduler verifies
    // the original invocation again rather than trusting a caller-provided flag.
    runScheduled: invocation => getProfile().scheduler.runScheduled(invocation)
  };
  const handleManagement = createManagementHttpHandler({...options, controller, authenticateInvocation,
    enabled: options.managementEnabled === true});
  const closedBootstrap = createBootstrapRuntime({transportGuard: options.transportGuard,
    jitProviderLifetimeQualified: false});
  const handleBootstrap = options.jitProviderLifetimeQualified !== true ? closedBootstrap.handle : async (req, res) => {
    try {
      if (typeof options.transportGuard !== 'function' || !await options.transportGuard(req))
        return res.status(403).json({ok: false, code: 'BOOTSTRAP_IDENTITY_REJECTED'});
      return await getProfile().bootstrap.handle(req, res);
    } catch (_) {return res.status(503).json({ok: false, code: 'BOOTSTRAP_UNAVAILABLE'});}
  };
  async function runScheduled(invocation) {
    if (options.scheduledEnabled !== true) return {status: 'disabled'};
    try {
      const authority = authorityConfiguration(options);
      if (!principalRole(await authenticateInvocation(invocation), authority)) return {status: 'denied'};
      return await getProfile().scheduler.runScheduled(invocation);
    } catch (_) {return {status: 'preserved'};}
  }
  return Object.freeze({handleManagement, handleBootstrap, runScheduled});
}
module.exports = {createControllerRuntime};
