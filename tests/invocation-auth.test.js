'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createInvocationAuthenticator} = require('../cloud-functions/webhook-handler/invocation-auth');
const audience = 'https://controller.example.invalid/management';
const adminSubject = '111111', schedulerSubject = '222222';
const token = 'a'.repeat(64) + '.' + 'b'.repeat(64) + '.' + 'c'.repeat(64);
const request = authorization => ({get: name => name === 'authorization' ? authorization : undefined,
  body: {verified: true, role: 'admin', subject: adminSubject}});
const claims = {iss: 'https://accounts.google.com', aud: audience, sub: adminSubject, iat: 100, exp: 1000};
function fixture(options = {}) {
  let calls = 0;
  const authenticate = createInvocationAuthenticator({audience, adminSubject, schedulerSubject,
    clock: () => 200000, verifierQualified: true,
    verifyToken: async (received, args) => {calls++; assert.equal(received, token);
      assert.deepEqual(args, {audience}); return {...claims};}, ...options});
  return {authenticate, calls: () => calls};
}
test('default verification is closed before touching any trusted adapter', async () => {
  let calls = 0;
  const auth = createInvocationAuthenticator({audience, adminSubject, schedulerSubject,
    verifyToken: async () => {calls++; return claims;}});
  assert.equal(await auth(request('Bearer ' + token)), null); assert.equal(calls, 0);
});
test('verified subject fixes role and ignores body and token role claims', async () => {
  const f = fixture();
  assert.deepEqual(await f.authenticate(request('Bearer ' + token)), {verified: true, audience, subject: adminSubject, role: 'admin'});
  const scheduler = fixture({verifyToken: async () => ({...claims, sub: schedulerSubject, role: 'admin'})});
  assert.equal((await scheduler.authenticate(request('Bearer ' + token))).role, 'scheduler');
});
test('wrong issuer audience subject expiry lifetime and malformed claim types deny', async () => {
  for (const patch of [{iss: 'https://issuer.example.invalid'}, {aud: [audience]}, {aud: audience + '/other'},
    {sub: '333333'}, {sub: Number(adminSubject)}, {exp: 200}, {iat: 201}, {iat: -1},
    {iat: '100'}, {exp: 5000}, {exp: 100}, {exp: NaN}, {nbf: 201}, {nbf: '100'}]) {
    const f = fixture({verifyToken: async () => ({...claims, ...patch})});
    assert.equal(await f.authenticate(request('Bearer ' + token)), null);
  }
});
test('missing malformed and duplicate bearer forms never reach verifier', async () => {
  for (const header of [undefined, token, 'bearer ' + token, 'Bearer ' + token + ', Bearer ' + token,
    'Bearer a.b.c extra', 'Bearer ' + 'a'.repeat(17000)]) {
    const f = fixture(); assert.equal(await f.authenticate(request(header)), null); assert.equal(f.calls(), 0);
  }
});
test('verifier errors clock anomalies and invalid authority configuration fail closed', async () => {
  for (const options of [{verifyToken: async () => {throw Error('synthetic_verification_error');}},
    {clock: () => NaN}, {clock: () => -1}, {audience: 'http://controller.example.invalid'},
    {audience: audience + '?route=admin'}, {schedulerSubject: adminSubject}, {maximumLifetimeSeconds: 0}]) {
    const f = fixture(options); assert.equal(await f.authenticate(request('Bearer ' + token)), null);
  }
});
