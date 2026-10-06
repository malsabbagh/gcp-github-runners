'use strict';

// Run against an independently installed, materialized source profile. All
// fixtures are synthetic; HTTP requests stay on loopback and no SDK is invoked.
const assert = require('node:assert/strict');
const {test} = require('node:test');
const {createRequire} = require('node:module');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');

assert.ok(process.env.SOURCE_PROFILE_DIR, 'SOURCE_PROFILE_DIR must name the installed profile');
const root = path.resolve(process.env.SOURCE_PROFILE_DIR);
const source = createRequire(path.join(root, 'package.json'));
const hybrid = createRequire(path.join(root, 'cloud-functions/hybrid-cleanup-handler/package.json'));

test('source matching APIs accept supported globs and reject unrelated paths', () => {
  const picomatch = source('picomatch');
  const minimatch = source('minimatch');
  for (const match of [picomatch('**/*.js'), file => minimatch(file, '**/*.js')]) {
    assert.equal(match('cloud-functions/webhook-handler/index.js'), true);
    assert.equal(match('cloud-functions/webhook-handler/package.json'), false);
    assert.equal(match('.private/index.js'), false);
  }
  assert.doesNotThrow(() => picomatch('[[:constructor:]]'));
});

test('source Ajv validates nested data, types and additional properties', () => {
  const Ajv = source('ajv');
  const validate = new Ajv().compile({type: 'object', additionalProperties: false,
    required: ['job'], properties: {job: {type: 'object', required: ['id'],
      properties: {id: {type: 'integer', minimum: 1}}}}});
  assert.equal(validate({job: {id: 42}}), true);
  for (const data of [{}, {job: {id: '42'}}, {job: {id: 0}}, {job: {id: 42}, extra: true}]) {
    assert.equal(validate(data), false);
    assert.ok(validate.errors.length);
  }
});

test('source JWS authenticates HMAC and RSA tokens and rejects tampering', () => {
  const jws = source('jws');
  const key = Buffer.alloc(32, 42);
  const token = jws.sign({header: {alg: 'HS256'}, payload: {job: 42}, secret: key});
  assert.equal(jws.verify(token, 'HS256', key), true);
  assert.equal(jws.verify(token, 'HS256', 'wrong-test-key'), false);
  const parts = token.split('.');
  parts[1] = Buffer.from('{"job":43}').toString('base64url');
  assert.equal(jws.verify(parts.join('.'), 'HS256', key), false);
  const {privateKey, publicKey} = crypto.generateKeyPairSync('rsa', {modulusLength: 2048});
  const rsa = jws.sign({header: {alg: 'RS256'}, payload: {job: 42}, privateKey});
  assert.equal(jws.verify(rsa, 'RS256', publicKey), true);
  assert.throws(() => jws.verify(token, undefined, key), {code: 'MISSING_ALGORITHM'});
});

test('hybrid proxy address handling honors trusted hops and stops at untrusted peers', () => {
  const proxy = hybrid('proxy-addr');
  const trusted = proxy.compile(['loopback', '10.0.0.0/8']);
  const req = {socket: {remoteAddress: '127.0.0.1'}, headers: {'x-forwarded-for': '198.51.100.7, 10.0.0.2'}};
  assert.equal(proxy(req, trusted), '198.51.100.7');
  req.socket.remoteAddress = '203.0.113.9';
  assert.equal(proxy(req, trusted), '203.0.113.9');
  assert.equal(trusted('::ffff:127.0.0.1'), true);
  assert.throws(() => proxy.compile('not-a-subnet'));
});

test('hybrid SDK clients load their independent dependency graph without provider calls', async () => {
  for (const [name, constructor] of [['@google-cloud/firestore', 'Firestore'],
    ['@google-cloud/secret-manager', 'SecretManagerServiceClient'],
    ['@google-cloud/pubsub', 'PubSub'], ['@google-cloud/compute', 'InstancesClient']]) {
    const Client = hybrid(name)[constructor];
    const client = new Client({projectId: 'sample-config-000'});
    assert.ok(client);
    if (typeof client.close === 'function') await client.close();
    if (typeof client.terminate === 'function') await client.terminate();
  }
});

test('hybrid gRPC and its own proto-loader round-trip unary data and status on loopback', {timeout: 10000}, async () => {
  const grpc = hybrid('@grpc/grpc-js');
  const grpcRequire = createRequire(hybrid.resolve('@grpc/grpc-js'));
  const loader = grpcRequire('@grpc/proto-loader');
  const protobuf = grpcRequire('protobufjs');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-grpc-contract-'));
  const proto = path.join(temp, 'contract.proto');
  fs.writeFileSync(proto, 'syntax="proto3"; package fixture; message Job { string id=1; bytes payload=2; } service Cleanup { rpc Echo(Job) returns (Job); }');
  const Type = protobuf.loadSync(proto).lookupType('fixture.Job');
  const value = {id: 'job-42', payload: Buffer.from('caf\u00e9')};
  assert.equal(Type.decode(Type.encode(value).finish()).id, value.id);
  assert.throws(() => Type.decode(Buffer.from([0x0a, 0xff])));
  const Cleanup = grpc.loadPackageDefinition(loader.loadSync(proto)).fixture.Cleanup;
  const server = new grpc.Server();
  server.addService(Cleanup.service, {echo(call, callback) {
    if (call.request.id === 'reject') return callback({code: grpc.status.INVALID_ARGUMENT, details: 'fixture rejection'});
    callback(null, call.request);
  }});
  let client;
  try {
    const port = await new Promise((resolve, reject) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, port) => error ? reject(error) : resolve(port)));
    client = new Cleanup(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
    const echo = request => new Promise((resolve, reject) => client.echo(request, {deadline: Date.now() + 3000}, (error, result) => error ? reject(error) : resolve(result)));
    const result = await echo(value);
    assert.equal(result.id, value.id);
    assert.deepEqual(result.payload, value.payload);
    await assert.rejects(echo({id: 'reject'}), error => error.code === grpc.status.INVALID_ARGUMENT && error.details === 'fixture rejection');
  } finally {
    if (client) client.close();
    server.forceShutdown();
    fs.rmSync(temp, {recursive: true, force: true});
  }
});

for (const [name, load] of [['source', source], ['hybrid', hybrid]]) {
  test(`${name} Functions Framework preserves raw JSON bytes and signature decisions over HTTP`, {timeout: 10000}, async () => {
    const framework = load.resolve('@google-cloud/functions-framework');
    const {getServer} = load(path.join(path.dirname(framework), 'server.js'));
    const key = 'synthetic-http-test-key';
    const server = getServer((req, res) => {
      const signature = crypto.createHmac('sha256', key).update(req.rawBody).digest('hex');
      if (signature !== req.headers['x-fixture-signature']) return res.status(401).end();
      res.json({raw: req.rawBody.toString('hex'), message: req.body.message, ip: req.ip});
    }, {signatureType: 'http', ignoredRoutes: null, timeoutMilliseconds: 5000});
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const request = (body, signature) => new Promise((resolve, reject) => {
      const req = http.request({host: '127.0.0.1', port: server.address().port,
        path: '/fixture', method: 'POST', headers: {'content-type': 'application/json',
          'content-length': body.length, 'x-fixture-signature': signature,
          'x-forwarded-for': '198.51.100.7'}}, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({status: res.statusCode, body: Buffer.concat(chunks).toString()}));
      });
      req.on('error', reject);
      req.end(body);
    });
    try {
      const body = Buffer.from('{ "message": "caf\u00e9", "values": [1, 2] }');
      const signature = crypto.createHmac('sha256', key).update(body).digest('hex');
      const result = await request(body, signature);
      assert.equal(result.status, 200);
      assert.deepEqual(JSON.parse(result.body), {raw: body.toString('hex'), message: 'caf\u00e9', ip: '198.51.100.7'});
      assert.equal((await request(body, 'invalid')).status, 401);
      assert.equal((await request(Buffer.from('{invalid'), signature)).status, 400);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
}
