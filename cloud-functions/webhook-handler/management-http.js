'use strict';
const {isDeepStrictEqual} = require('node:util');
const fields = ['key', 'token', 'name', 'zone', 'project', 'instanceId', 'instanceCreationTimestamp', 'claimId'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
function validRequest(value) {
  return object(value) && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key)) &&
    typeof value.key === 'string' && /^[a-f0-9]{64}$/.test(value.key) && uuid(value.token) && uuid(value.claimId) &&
    typeof value.name === 'string' && /^[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(value.name) &&
    typeof value.zone === 'string' && /^[a-z]+(?:-[a-z]+)+[0-9]+-[a-z]$/.test(value.zone) &&
    typeof value.project === 'string' && /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value.project) &&
    typeof value.instanceId === 'string' && /^[1-9][0-9]{0,19}$/.test(value.instanceId) &&
    typeof value.instanceCreationTimestamp === 'string' && value.instanceCreationTimestamp.length <= 40 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value.instanceCreationTimestamp) &&
    Number.isFinite(Date.parse(value.instanceCreationTimestamp));
}
function authorityConfiguration({expectedAudience, expectedCallerSubject, adminSubject = expectedCallerSubject,
                                 schedulerSubject = null}) {
  let audience;
  try {audience = new URL(expectedAudience);} catch (_) {throw Error('MANAGEMENT_CONFIGURATION_INVALID');}
  const subject = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  if (audience.protocol !== 'https:' || audience.username || audience.password || audience.search || audience.hash ||
      typeof expectedAudience !== 'string' || (!subject(adminSubject) && !subject(schedulerSubject)) ||
      (adminSubject !== undefined && adminSubject !== null && !subject(adminSubject)) ||
      (schedulerSubject !== null && !subject(schedulerSubject)) ||
      (adminSubject && adminSubject === schedulerSubject)) throw Error('MANAGEMENT_CONFIGURATION_INVALID');
  return Object.freeze({expectedAudience, adminSubject, schedulerSubject});
}
function principalRole(principal, configuration) {
  if (!object(principal) || principal.verified !== true || principal.audience !== configuration.expectedAudience)
    return null;
  if (principal.role === 'admin' && configuration.adminSubject && principal.subject === configuration.adminSubject)
    return 'admin';
  if (principal.role === 'scheduler' && configuration.schedulerSubject && principal.subject === configuration.schedulerSubject)
    return 'scheduler';
  return null;
}
const operations = Object.freeze({requestDrain: 'requestDrain', prepareStop: 'prepareStop',
  dispatchDrain: 'dispatchIntent', dispatchStop: 'dispatchIntent', retire: 'retireAllocation',
  reconcileOrphan: 'reconcileOrphan', recover: 'recover', scheduled: 'runScheduled'});
const safeStatuses = new Set(['preserved', 'intent_recorded', 'retired', 'orphan_reconciled', 'hydrated',
  'released', 'absent', 'dispatched', 'acknowledged', 'completed', 'reconciled', 'disabled', 'denied']);
function createManagementHttpHandler({authenticateInvocation = async () => null, controller, enabled = false,
                                     ...authority}) {
  const configuration = enabled === true ? authorityConfiguration(authority) : null;
  if (typeof authenticateInvocation !== 'function') throw Error('MANAGEMENT_CONFIGURATION_INVALID');
  return async (req, res) => {
    res.set('Cache-Control', 'no-store'); res.set('X-Content-Type-Options', 'nosniff');
    const respond = (status, code, extra = {}) => res.status(status).json({ok: status === 200, code, ...extra});
    if (enabled !== true) return respond(503, 'MANAGEMENT_DISABLED');
    try {
      // This result must originate in a trusted token verifier. Neither body,
      // forwarded/proxy headers nor a request.verified flag is consulted here.
      const role = principalRole(await authenticateInvocation(req), configuration);
      if (!role) return respond(403, 'MANAGEMENT_IDENTITY_REJECTED');
      const route = typeof req.path === 'string' && /^\/management\/([A-Za-z]+)$/.exec(req.path);
      const operation = route && route[1];
      if (req.method !== 'POST' || !operation || !Object.hasOwn(operations, operation) ||
          req.originalUrl !== undefined && req.originalUrl !== req.path ||
          typeof req.is !== 'function' || !req.is('application/json') ||
          !Buffer.isBuffer(req.rawBody) || req.rawBody.length < 2 || req.rawBody.length > 4096)
        return respond(400, 'MANAGEMENT_INVALID');
      if (role === 'scheduler' && !['recover', 'scheduled'].includes(operation))
        return respond(403, 'MANAGEMENT_ROLE_REJECTED');
      const text = req.rawBody.toString('utf8');
      let body;
      try {body = JSON.parse(text);} catch (_) {return respond(400, 'MANAGEMENT_INVALID');}
      // Canonical JSON is deliberately required: duplicate keys, ambiguous UTF-8,
      // extra whitespace and alternate escape encodings cannot change routing.
      if (!Buffer.from(text, 'utf8').equals(req.rawBody) || JSON.stringify(body) !== text ||
          !isDeepStrictEqual(body, req.body) || !object(body)) return respond(400, 'MANAGEMENT_INVALID');
      const method = operations[operation];
      if (!controller || typeof controller[method] !== 'function') return respond(503, 'MANAGEMENT_UNAVAILABLE');
      let answer;
      if (operation === 'scheduled') {
        if (Object.keys(body).length !== 0) return respond(400, 'MANAGEMENT_INVALID');
        // Scheduled composition independently authenticates the same invocation.
        answer = await controller.runScheduled(req);
      } else {
        if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'request') || !validRequest(body.request))
          return respond(400, 'MANAGEMENT_INVALID');
        const request = Object.fromEntries(fields.map(key => [key, body.request[key]]));
        answer = await controller[method](['dispatchDrain', 'dispatchStop'].includes(operation) ?
          {...request, phase: operation === 'dispatchDrain' ? 'drain' : 'stop'} : request);
      }
      if (!object(answer) || !safeStatuses.has(answer.status)) return respond(503, 'MANAGEMENT_UNAVAILABLE');
      // No provider exception, arbitrary reason, IDs, adapter options or material
      // is echoed. Detailed durable diagnostics remain inside the canonical store.
      return respond(200, 'MANAGEMENT_HANDLED', {status: answer.status});
    } catch (_) {return respond(503, 'MANAGEMENT_UNAVAILABLE');}
  };
}
module.exports = {createManagementHttpHandler, authorityConfiguration, principalRole, validRequest};
