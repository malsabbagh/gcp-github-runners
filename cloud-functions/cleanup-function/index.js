'use strict';
// Compatibility command adapter only. Cloud Scheduler calls the unified
// authenticated management endpoint directly; no cleanup build or second HTTP
// retirement service exists here.
function configuration(env=process.env) {
  const url=new URL(env.CLEANUP_CONTROLLER_URL||'https://invalid.invalid');
  const audience=env.CONTROLLER_AUDIENCE;
  const base=new URL(audience||'https://invalid.invalid');
  if (!env.CLEANUP_CONTROLLER_URL || url.protocol!=='https:' || url.username || url.password || url.search || url.hash ||
      base.protocol!=='https:' || base.search || base.hash || base.username || base.password || url.origin!==base.origin ||
      url.pathname!==base.pathname.replace(/\/$/,'')+'/management/scheduled') throw Error('invalid_cleanup_configuration');
  return {controller:url.href,audience};
}
function validAge(value) {if (!Number.isSafeInteger(value)||value<0||value>8760) throw Error('invalid_cleanup_age');}
function createCleanupInvoker({environment=process.env,identityClientFactory}={}) {
  let client;
  return async()=> {
    const cfg=configuration(environment);
    try {
      if(!client) client=identityClientFactory?await identityClientFactory(cfg.audience):await new (require('google-auth-library').GoogleAuth)().getIdTokenClient(cfg.audience);
      const response=await client.request({url:cfg.controller,method:'POST',data:{},headers:{'Content-Type':'application/json'},maxRedirects:0,timeout:30000});
      if(response.status!==200 || response.data?.ok!==true || response.data?.code!=='MANAGEMENT_HANDLED' ||
          !['completed','preserved','disabled','denied'].includes(response.data.status)) throw Error('invalid_response');
      return {status:response.data.status};
    }catch(_){throw Error('cleanup_invocation_uncertain');}
  };
}
async function cleanupOldRunners(maxAgeHours=2) {validAge(maxAgeHours);return createCleanupInvoker()();}
module.exports={configuration,validAge,createCleanupInvoker,cleanupOldRunners,createRetirementController:require('./retirement-controller').createRetirementController};
