'use strict';

// Cloud HTTPS/IAM ingress and an exact invocation audience must be explicitly
// wired by the supported deployment. Never trust arbitrary forwarded headers.
function createBootstrapHttpHandler({ broker, transportGuard = () => false }) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('Pragma', 'no-cache');
    res.set('X-Content-Type-Options', 'nosniff');
    try {
      if (!await transportGuard(req)) return res.status(403).json({ ok: false, code: 'BOOTSTRAP_IDENTITY_REJECTED' });
      const authorization = req.get('authorization');
      if (req.method !== 'POST' || !req.is('application/json') ||
          !Buffer.isBuffer(req.rawBody) || req.rawBody.length > 8192 ||
          typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9_.-]{64,16384}$/.test(authorization))
        return res.status(400).json({ ok: false, code: 'BOOTSTRAP_INVALID' });
      const operation = req.get('x-bootstrap-operation');
      if (!['readiness', 'exchange'].includes(operation))
        return res.status(400).json({ ok: false, code: 'BOOTSTRAP_INVALID' });
      const result = await (operation === 'readiness' ? broker.inspect(req.body, authorization.slice(7)) :
        broker.exchange(req.body, authorization.slice(7)));
      // No middleware request/response logging is allowed on this material path.
      if (result.ok) return res.status(200).json(result);
      const status = result.code === 'BOOTSTRAP_IDENTITY_REJECTED' ? 403 :
        result.code === 'BOOTSTRAP_INVALID' ? 400 : result.code === 'BOOTSTRAP_UNAVAILABLE' ? 503 : 409;
      return res.status(status).json({ ok: false, code: result.code });
    } catch (_) { return res.status(503).json({ ok: false, code: 'BOOTSTRAP_UNAVAILABLE' }); }
  };
}
module.exports = { createBootstrapHttpHandler };
