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
