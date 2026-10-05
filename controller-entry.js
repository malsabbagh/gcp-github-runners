'use strict';
// Pure root archive entry. No SDK initialization, server registration, ambient
// config reads or provider calls occur on import. Deployment is not qualified.
function createControllerDeployment(options, { runtimeFactory } = {}) {
  const factory = runtimeFactory || require('./cloud-functions/webhook-handler/controller-runtime').createControllerRuntime;
  if (typeof factory !== 'function') throw Error('CONTROLLER_ENTRY_UNWIRED');
  return factory(options);
}
module.exports = { createControllerDeployment };
