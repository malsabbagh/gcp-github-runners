'use strict';
// Framework registration creates no SDK clients, retrieves no credentials, and
// makes no provider call. Runtime composition is lazy and closed by default.
function createControllerDeployment(options, {runtimeFactory} = {}) {
  const factory=runtimeFactory || require('./cloud-functions/webhook-handler/controller-runtime').createControllerRuntime;
  if (typeof factory!=='function') throw Error('CONTROLLER_ENTRY_UNWIRED');
  return factory(options);
}
let deployment;
async function controllerHttp(req,res) {
  if (!deployment) deployment=require('./cloud-functions/webhook-handler/deployment-runtime').createProductionDeployment();
  return deployment.handle(req,res);
}
require('@google-cloud/functions-framework').http('controllerHttp',controllerHttp);
module.exports={createControllerDeployment,controllerHttp};
