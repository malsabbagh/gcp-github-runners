'use strict';

// The verifier is a trusted deployment adapter: it must verify the signature,
// issuer and audience. Caller headers/body can never provide verified claims.
// No verifier or SDK is constructed here; qualification defaults closed.
function createInvocationAuthenticator({ verifyToken, verifierQualified = false,
  audience, adminSubject, schedulerSubject, clock = Date.now, maximumLifetimeSeconds = 3600 } = {}) {
  let valid = false;
  try {
    const url = new URL(audience);
    valid = url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
      typeof adminSubject === 'string' && /^[1-9][0-9]{5,30}$/.test(adminSubject) &&
      typeof schedulerSubject === 'string' && /^[1-9][0-9]{5,30}$/.test(schedulerSubject) &&
      adminSubject !== schedulerSubject && Number.isSafeInteger(maximumLifetimeSeconds) &&
      maximumLifetimeSeconds >= 1 && maximumLifetimeSeconds <= 3600;
  } catch (_) { /* Invalid configuration stays closed. */ }
  return async function authenticateInvocation(req) {
    if (!valid || verifierQualified !== true || typeof verifyToken !== 'function') return null;
    try {
      const authorization = req.get('authorization');
      if (typeof authorization !== 'string' || authorization.length > 16391 ||
          !/^Bearer [A-Za-z0-9_-]{1,8192}\.[A-Za-z0-9_-]{1,8192}\.[A-Za-z0-9_-]{1,8192}$/.test(authorization)) return null;
      const claims = await verifyToken(authorization.slice(7), {audience});
      const nowMs = clock(), now = Math.floor(nowMs / 1000);
      if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !claims || typeof claims !== 'object' || Array.isArray(claims) ||
          !['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss) ||
          claims.aud !== audience || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) ||
          claims.iat < 0 || claims.iat > now || claims.exp <= now || claims.exp <= claims.iat ||
          (Object.hasOwn(claims, 'nbf') && (!Number.isSafeInteger(claims.nbf) || claims.nbf > now)) ||
          claims.exp - claims.iat > maximumLifetimeSeconds) return null;
      const role = claims.sub === adminSubject ? 'admin' : claims.sub === schedulerSubject ? 'scheduler' : null;
      return role ? Object.freeze({verified: true, audience, subject: claims.sub, role}) : null;
    } catch (_) { return null; }
  };
}

module.exports = {createInvocationAuthenticator};
