"use strict";
// Compatibility entry for the webhook workspace. Unified deployment uses the
// same factory with shared clients and registers only controllerHttp.
const {createWebhookRuntime} = require('./webhook-runtime');
const runtime = createWebhookRuntime();
require('@google-cloud/functions-framework').http('webhookHandler', runtime.webhookHandler);
function prepareControllerProfile(options = {}) {
  return require('./controller-profile').createControllerProfile({...options, infrastructureConfig: runtime.infrastructureConfig, ...runtime.clients, environment: process.env, registeredLabels: runtime.registeredLabels});
}
module.exports = {...runtime, prepareControllerProfile};
