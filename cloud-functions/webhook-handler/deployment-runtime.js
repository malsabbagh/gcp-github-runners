'use strict';
const {createControllerRuntime} = require('./controller-runtime');
const {readInfrastructureConfiguration,validateConfiguration} = require('./infrastructure-config');
const flag = (env,name) => {if (env[name]!==undefined && !['true','false'].includes(env[name])) throw Error('DEPLOYMENT_CONFIGURATION_INVALID');return env[name]==='true';};
// Official Google token verification supplies signature/issuer/audience checks;
// invocation-auth applies distinct immutable service-account subject roles.
function createGoogleInvocationVerifier({OAuth2Client} = {}) {
  let client;
  return async (token,{audience}) => {
    if (!client) {const Constructor=OAuth2Client || require('google-auth-library').OAuth2Client;client=new Constructor();}
    return (await client.verifyIdToken({idToken:token,audience})).getPayload();
  };
}
function readReadiness(env) {
  return {webhookEnabled:flag(env,'WEBHOOK_ENABLED'),managementEnabled:flag(env,'MANAGEMENT_ENABLED'),scheduledEnabled:flag(env,'SCHEDULED_ENABLED'),
    jitProviderLifetimeQualified:flag(env,'JIT_PROVIDER_LIFETIME_QUALIFIED'),approvedQuiescence:flag(env,'APPROVED_QUIESCENCE'),
    dispatchEnabled:flag(env,'DISPATCH_ENABLED'),workerDrainQualified:flag(env,'WORKER_DRAIN_QUALIFIED'),workerStopQualified:flag(env,'WORKER_STOP_QUALIFIED')};
}
function createProductionDeployment({environment:suppliedEnvironment=process.env,clients={},webhookFactory,controllerFactory=createControllerRuntime,workerControlFactory,invocationVerifier}={}) {
  const environment=Object.freeze({...suppliedEnvironment});
  const readiness=readReadiness(environment);
  let composed;
  function compose() {
    if (composed) return composed;
    const cfg=readInfrastructureConfiguration(environment);validateConfiguration(environment,cfg);
    const webhook=(webhookFactory || require('./webhook-runtime').createWebhookRuntime)({environment,infrastructureConfig:cfg,clients});
    const tokenShape=req=>typeof req.get==='function' && /^Bearer [A-Za-z0-9_.-]{64,16384}$/.test(req.get('authorization')||'');
    let managedVerifier;
    const verifyIdentity=(assertion,allocation)=> {
      if (!managedVerifier) managedVerifier=require('./managed-instance-verifier').createGoogleManagedInstanceVerifier({audience:cfg.ALLOCATION_BROKER_URL});
      return managedVerifier(assertion,allocation);
    };
    const workerControl=(workerControlFactory || require('./worker-control').createWorkerControl)({firestore:webhook.clients.firestore,verifyIdentity,infrastructureConfig:cfg,
      repositoryOwner:environment.GITHUB_REPO_OWNER,repositoryName:environment.GITHUB_REPO_NAME,
      enabled:readiness.dispatchEnabled && readiness.workerDrainQualified && readiness.workerStopQualified && readiness.approvedQuiescence});
    const controller=controllerFactory({...readiness,infrastructureConfig:cfg,...webhook.clients,environment,
      registeredLabels:webhook.registeredLabels,transportGuard:tokenShape,workerControl,provisioning:webhook.provisioning,isEligible:webhook.eligible,
      invocationVerifier:invocationVerifier || createGoogleInvocationVerifier(),invocationVerifierQualified:true,
      expectedAudience:environment.CONTROLLER_AUDIENCE,adminSubject:environment.ADMIN_SERVICE_ACCOUNT_UNIQUE_ID,
      schedulerSubject:environment.SCHEDULER_SERVICE_ACCOUNT_UNIQUE_ID});
    return composed={webhook,controller,workerControl};
  }
  return Object.freeze({
    readiness:Object.freeze(readiness),
    async handle(req,res) {
      res.set('Cache-Control','no-store');res.set('X-Content-Type-Options','nosniff');
      try {
        const path=req.path;
        if (typeof path!=='string' || req.originalUrl!==undefined && req.originalUrl!==path) return res.status(400).json({ok:false,code:'CONTROLLER_INVALID'});
        if (path==='/healthz') return res.status(200).json({ok:true,code:'CONTROLLER_READY',enabled:readiness});
        if (path==='/webhook') {
          if (!readiness.webhookEnabled) return res.status(503).json({ok:false,code:'WEBHOOK_DISABLED'});
          return await compose().webhook.webhookHandler(req,res);
        }
        if (/^\/management\/[A-Za-z]+$/.test(path)) {
          if (!readiness.managementEnabled) return res.status(503).json({ok:false,code:'MANAGEMENT_DISABLED'});
          return await compose().controller.handleManagement(req,res);
        }
        // Bootstrap URL is owner-supplied configuration, never a forwarded host.
        let brokerPath='/bootstrap';
        if (environment.ALLOCATION_BROKER_URL) {
          const broker=new URL(environment.ALLOCATION_BROKER_URL),base=new URL(environment.CONTROLLER_AUDIENCE);
          const prefix=base.pathname.replace(/\/$/,'');
          if (broker.origin!==base.origin || !broker.pathname.startsWith(prefix+'/') || base.search || base.hash || base.username || base.password) throw Error('DEPLOYMENT_CONFIGURATION_INVALID');
          brokerPath=broker.pathname.slice(prefix.length).replace(/\/$/,'');
        }
        if (path===brokerPath) {
          if (!readiness.jitProviderLifetimeQualified) return res.status(503).json({ok:false,code:'BOOTSTRAP_UNAVAILABLE'});
          return await compose().controller.handleBootstrap(req,res);
        }
        if ([`${brokerPath}/worker-control/poll`,`${brokerPath}/worker-control/ack`].includes(path)) {
          if (!readiness.dispatchEnabled) return res.status(503).json({ok:false,code:'WORKER_CONTROL_DISABLED'});
          return await compose().workerControl.handle(req,res);
        }
        return res.status(404).json({ok:false,code:'CONTROLLER_ROUTE_NOT_FOUND'});
      } catch (_) {return res.status(503).json({ok:false,code:'CONTROLLER_UNAVAILABLE'});}
    }
  });
}
module.exports={createProductionDeployment,createGoogleInvocationVerifier,readReadiness};
