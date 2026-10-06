'use strict';

// Exercise the hybrid package's own installed dependency closure with synthetic
// local servers. No cloud requests, operator inputs or deployment are involved.
const assert = require('node:assert/strict');
const {test} = require('node:test');
const {createRequire} = require('node:module');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
assert.ok(process.env.SOURCE_PROFILE_DIR);
const load = createRequire(path.join(process.env.SOURCE_PROFILE_DIR,
  'cloud-functions/hybrid-cleanup-handler/package.json'));
const axios = load('axios');

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {server, url: `http://127.0.0.1:${server.address().port}`};
}
async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
async function fixture() {
  return listen((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, {location: '/echo'}); return res.end(); }
    if (req.url === '/loop') { res.writeHead(302, {location: '/loop'}); return res.end(); }
    if (req.url === '/slow') return setTimeout(() => res.end('late fixture'), 150).unref();
    if (req.url === '/error') { res.writeHead(503, {'content-type': 'application/json'}); return res.end('{"fixture":"unavailable"}'); }
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({body: Buffer.concat(chunks).toString(), headers: req.headers}));
    });
  });
}

test('hybrid Axios follows bounded redirects and retains structured HTTP errors', {timeout: 5000}, async () => {
  const {server, url} = await fixture();
  try {
    assert.equal((await axios.get(url + '/redirect', {proxy: false})).status, 200);
    await assert.rejects(axios.get(url + '/loop', {proxy: false, maxRedirects: 2}), error => error.code === 'ERR_FR_TOO_MANY_REDIRECTS');
    await assert.rejects(axios.get(url + '/error', {proxy: false}), error => axios.isAxiosError(error) &&
      error.code === 'ERR_BAD_RESPONSE' && error.response.status === 503 && error.response.data.fixture === 'unavailable');
    assert.equal((await axios.get(url + '/error', {proxy: false, validateStatus: status => status === 503})).status, 503);
  } finally { await close(server); }
});

test('hybrid Axios timeout and AbortSignal cancellation retain distinct error contracts', {timeout: 5000}, async () => {
  const {server, url} = await fixture();
  try {
    await assert.rejects(axios.get(url + '/slow', {proxy: false, timeout: 20}), error => axios.isAxiosError(error) && error.code === 'ECONNABORTED');
    const controller = new AbortController();
    const pending = axios.get(url + '/slow', {proxy: false, signal: controller.signal});
    controller.abort();
    await assert.rejects(pending, error => axios.isCancel(error) && error.code === 'ERR_CANCELED');
  } finally { await close(server); }
});

test('hybrid Axios strips authorization when a redirect changes origin', {timeout: 5000}, async () => {
  const destination = await fixture();
  const origin = await listen((req, res) => { res.writeHead(302, {location: destination.url + '/echo'}); res.end(); });
  try {
    const result = await axios.get(origin.url, {proxy: false, headers: {authorization: 'fixture-only'}});
    assert.equal(result.data.headers.authorization, undefined);
  } finally { await close(origin.server); await close(destination.server); }
});

test('hybrid Axios uses only the configured loopback proxy and honors exact and CIDR NO_PROXY', {timeout: 5000}, async () => {
  const origin = await fixture();
  let hits = 0;
  const proxy = await listen((req, res) => { hits++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({proxied: true, target: req.url})); });
  const names = ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'no_proxy', 'NO_PROXY', 'npm_config_proxy', 'npm_config_http_proxy', 'npm_config_https_proxy', 'npm_config_no_proxy'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    process.env.http_proxy = proxy.url;
    const proxied = await axios.get(origin.url + '/echo');
    assert.equal(proxied.data.proxied, true);
    assert.equal(proxied.data.target, origin.url + '/echo');
    assert.equal(hits, 1);
    for (const exclusion of ['127.0.0.1', '127.0.0.0/8']) {
      process.env.no_proxy = exclusion;
      assert.equal((await axios.get(origin.url + '/echo')).data.proxied, undefined);
      assert.equal(hits, 1);
    }
    process.env.no_proxy = '192.0.2.0/24';
    assert.equal((await axios.get(origin.url + '/echo')).data.proxied, true);
    assert.equal(hits, 2);
  } finally {
    for (const name of names) previous[name] === undefined ? delete process.env[name] : process.env[name] = previous[name];
    await close(proxy.server); await close(origin.server);
  }
});

test('hybrid Axios sends its installed multipart form with a matching boundary', {timeout: 5000}, async () => {
  const {server, url} = await fixture();
  try {
    const Form = load('form-data');
    const form = new Form();
    form.append('fixture', 'local-value');
    const result = await axios.post(url + '/echo', form, {proxy: false, headers: form.getHeaders()});
    const boundary = /boundary=(.+)$/.exec(result.data.headers['content-type'])[1];
    assert.ok(result.data.body.startsWith('--' + boundary));
    assert.ok(result.data.body.includes('name="fixture"'));
    assert.ok(result.data.body.includes('local-value'));
    assert.ok(result.data.body.endsWith('--' + boundary + '--\r\n'));
  } finally { await close(server); }
});

test('hybrid fast-uri normalizes escaped host case and resolves schema references', () => {
  const uri = load('fast-uri');
  assert.equal(uri.normalize('HTTP://%45xAmPlE.test/a/../job.json'), 'http://example.test/job.json');
  assert.equal(uri.equal('http://%45xAmPlE.test/job.json', 'http://example.test/job.json'), true);
  assert.equal(uri.resolve('https://example.test/schemas/list.json', './job.json'), 'https://example.test/schemas/job.json');
  const ipv6 = uri.parse('https://[2001:db8::1]:8443/job');
  assert.equal(ipv6.error, undefined);
  assert.equal(uri.serialize(ipv6), 'https://[2001:db8::1]:8443/job');
  const Ajv = load('ajv');
  const ajv = new Ajv();
  ajv.addSchema({$id: 'https://example.test/schemas/job.json', type: 'object',
    required: ['id'], properties: {id: {type: 'integer', minimum: 1}}});
  const validate = ajv.compile({$id: 'https://example.test/schemas/list.json',
    type: 'array', items: {$ref: 'job.json'}});
  assert.equal(validate([{id: 42}]), true);
  assert.equal(validate([{id: '42'}]), false);
});

test('hybrid fast-uri rejects malformed authorities and injected serialized ports', () => {
  const uri = load('fast-uri');
  for (const value of ['http://[::1/path', 'http://a]b/path', 'http://example.test:abc/path']) {
    assert.ok(uri.parse(value).error, value);
  }
  for (const port of ['80/other', '80@other', '80?other']) {
    assert.throws(() => uri.serialize({scheme: 'http', host: 'example.test', port}), /port is malformed/);
  }
  assert.throws(() => uri.resolve('http://example.test/', 'http://a]b/path'), /malformed/);
});

test('hybrid query parser preserves nested arrays and rejects prototype keys; routes retain boundaries', () => {
  const qs = load('qs');
  assert.deepEqual(qs.parse('items[0]=one&items[1]=two&filter[state]=done'),
    {items: ['one', 'two'], filter: {state: 'done'}});
  assert.deepEqual(qs.parse('__proto__[fixturePolluted]=yes'), {});
  assert.equal(Object.prototype.fixturePolluted, undefined);
  const route = load('path-to-regexp')('/:one-:two-:three', []);
  assert.equal(route.test('/fixture-job-42'), true);
  assert.equal(route.test('/fixture-job-42/extra'), false);
  assert.equal(route.test('/' + 'a-'.repeat(5000) + 'a/extra'), false);
});

test('hybrid Functions Framework preserves signed form bytes, repeated queries and parser rejection', {timeout: 5000}, async () => {
  const framework = load.resolve('@google-cloud/functions-framework');
  const {getServer} = load(path.join(path.dirname(framework), 'server.js'));
  const key = Buffer.alloc(32, 42);
  let calls = 0;
  const server = getServer((req, res) => {
    calls++;
    const expected = crypto.createHmac('sha256', key).update(req.rawBody).digest('hex');
    if (expected !== req.headers['x-fixture-signature']) return res.status(401).end();
    res.json({raw: req.rawBody.toString('hex'), body: req.body, query: req.query});
  }, {signatureType: 'http', ignoredRoutes: null, timeoutMilliseconds: 3000});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const request = (body, type, query, signed = true) => new Promise((resolve, reject) => {
    const signature = signed ? crypto.createHmac('sha256', key).update(body).digest('hex') : 'invalid';
    const req = http.request({host: '127.0.0.1', port: server.address().port,
      path: '/fixture?' + query, method: 'POST', headers: {'content-type': type,
        'content-length': body.length, 'x-fixture-signature': signature}}, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({status: res.statusCode, body: Buffer.concat(chunks).toString()}));
    });
    req.on('error', reject);
    req.end(body);
  });
  try {
    const values = Array.from({length: 25}, (_, index) => 'item-' + index);
    const query = values.map(value => 'items=' + value).join('&') + '&__proto__[fixturePolluted]=yes';
    const form = Buffer.from('items%5B0%5D=one&items%5B1%5D=two&message=caf%C3%A9');
    const ok = await request(form, 'application/x-www-form-urlencoded', query);
    assert.equal(ok.status, 200);
    const result = JSON.parse(ok.body);
    assert.equal(result.raw, form.toString('hex'));
    assert.deepEqual(result.body, {items: ['one', 'two'], message: 'caf\u00e9'});
    assert.deepEqual(result.query.items, values);
    assert.equal(Object.prototype.fixturePolluted, undefined);
    assert.equal((await request(form, 'application/x-www-form-urlencoded', '', false)).status, 401);
    const before = calls;
    assert.equal((await request(Buffer.from('{invalid'), 'application/json', '')).status, 400);
    assert.equal(calls, before, 'malformed JSON must fail before the handler');
  } finally { await close(server); }
});

test('hybrid nested form-data escapes names and filenames without injecting multipart headers', () => {
  const typed = createRequire(load.resolve('@types/request/package.json'));
  const Form = typed('form-data');
  assert.notEqual(typed.resolve('form-data'), load.resolve('form-data'), 'qualify the independent 2.x copy');
  const form = new Form();
  form.append('field"\r\nX-Fixture: injected', Buffer.from('fixture-value'),
    {filename: 'file"\r\nX-Fixture: injected.txt'});
  const body = form.getBuffer().toString();
  assert.ok(body.includes('name="field%22%0D%0AX-Fixture: injected"'));
  assert.ok(body.includes('filename="file%22%0D%0AX-Fixture: injected.txt"'));
  assert.equal(body.includes('\r\nX-Fixture:'), false);
  assert.equal(body.split('Content-Disposition:').length, 2);
  assert.equal(form.getLengthSync(), Buffer.byteLength(body));
});

test('hybrid nested form-data submits Unicode and buffered files with consistent lengths', {timeout: 5000}, async () => {
  const Form = createRequire(load.resolve('@types/request/package.json'))('form-data');
  const {server, url} = await fixture();
  try {
    const form = new Form();
    form.append('message', 'caf\u00e9');
    form.append('upload', Buffer.from('fixture-file'), {filename: 'fixture.txt'});
    const result = await new Promise((resolve, reject) => form.submit(url + '/echo', (error, response) => {
      if (error) return reject(error);
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
    }));
    assert.equal(Number(result.headers['content-length']), Buffer.byteLength(result.body));
    const boundary = /boundary=(.+)$/.exec(result.headers['content-type'])[1];
    assert.ok(result.body.endsWith('--' + boundary + '--\r\n'));
    assert.ok(result.body.includes('caf\u00e9'));
    assert.ok(result.body.includes('filename="fixture.txt"'));
    assert.ok(result.body.includes('fixture-file'));
  } finally { await close(server); }
});
