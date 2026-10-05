'use strict';
const { BootstrapDenied, saneNow } = require('./allocation-bootstrap-store');
function reject() { throw new BootstrapDenied('BOOTSTRAP_IDENTITY_REJECTED'); }
function metadata(instance) {
  const result = new Map();
  if (!instance.metadata || !Array.isArray(instance.metadata.items)) reject();
  for (const item of instance.metadata.items) {
    if (!item || typeof item.key !== 'string' || typeof item.value !== 'string' ||
        result.has(item.key)) reject();
    result.set(item.key, item.value);
  }
  return result;
}
// Official SDK constructors are injectable only for later offline regressions.
// No certificates/JWT signatures or auth tokens are implemented by this module.
function createManagedInstanceVerifier({ audience, clock = Date.now,
  idTokenClient, instancesClient }) {
  if (typeof audience !== 'string' || !/^https:\/\/[^\s?#]+$/.test(audience) ||
      !idTokenClient || typeof idTokenClient.verifyIdToken !== 'function' ||
      !instancesClient || typeof instancesClient.get !== 'function') reject();
  return async function verifyIdentity(assertion, allocation) {
    try {
      const before = saneNow(clock);
      if (typeof assertion !== 'string' || assertion.length < 64 || assertion.length > 16384) reject();
      const ticket = await idTokenClient.verifyIdToken({ idToken: assertion, audience });
      const payload = ticket.getPayload();
      const gce = payload && payload.google && payload.google.compute_engine;
      if (!payload || !gce || !['https://accounts.google.com', 'accounts.google.com'].includes(payload.iss) ||
          payload.aud !== audience || payload.email_verified !== true ||
          payload.email !== allocation.workerServiceAccountEmail ||
          payload.sub !== allocation.workerServiceAccountUniqueId ||
          !Number.isSafeInteger(payload.exp) || !Number.isSafeInteger(payload.iat) ||
          payload.iat * 1000 > before + 30000 || payload.exp * 1000 <= before ||
          String(gce.instance_id) !== allocation.instanceId ||
          gce.instance_name !== allocation.name || gce.project_id !== allocation.project ||
          gce.zone !== allocation.zone) reject();
      const [instance] = await instancesClient.get({ project: allocation.project,
        zone: allocation.zone, instance: allocation.name });
      const after = saneNow(clock);
      if (after < before || payload.exp * 1000 <= after || !instance ||
          String(instance.id) !== allocation.instanceId || instance.name !== allocation.name ||
          instance.status !== 'RUNNING' || instance.creationTimestamp !== allocation.incarnation ||
          !instance.scheduling || instance.scheduling.provisioningModel !== 'SPOT' ||
          instance.scheduling.instanceTerminationAction !== 'DELETE' ||
          !Array.isArray(instance.serviceAccounts) || instance.serviceAccounts.length !== 1 ||
          instance.serviceAccounts[0].email !== allocation.workerServiceAccountEmail ||
          !Array.isArray(instance.networkInterfaces) || !instance.networkInterfaces.length ||
          instance.networkInterfaces.some(n => (n.accessConfigs || []).length ||
            (n.ipv6AccessConfigs || []).length)) reject();
      const attrs = metadata(instance);
      const expected = {
        'allocation-key': allocation.allocationKey,
        'reservation-token': allocation.reservationToken,
        'repo-owner': allocation.repositoryOwner, 'repo-name': allocation.repositoryName,
        'run-id': allocation.runId, 'job-id': allocation.jobId, 'run-attempt': allocation.attempt,
        'allocation-broker-url': audience,
        'bootstrap-expires-at-ms': String(allocation.bootstrapExpiresAtMs)
      };
      for (const [key, value] of Object.entries(expected)) if (attrs.get(key) !== value) reject();
      return { audience, project: allocation.project, zone: allocation.zone,
        name: instance.name, instanceId: String(instance.id), incarnation: instance.creationTimestamp,
        serviceAccountEmail: payload.email, serviceAccountUniqueId: payload.sub,
        expiresAtMs: payload.exp * 1000, checkedAtMs: after };
    } catch (_) { reject(); }
  };
}
function createGoogleManagedInstanceVerifier(config) {
  const { OAuth2Client } = require('google-auth-library');
  const { InstancesClient } = require('@google-cloud/compute');
  return createManagedInstanceVerifier({ ...config,
    idTokenClient: new OAuth2Client(), instancesClient: new InstancesClient() });
}
module.exports = { createManagedInstanceVerifier, createGoogleManagedInstanceVerifier };
