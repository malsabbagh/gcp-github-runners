'use strict';
const { BootstrapDenied, BootstrapMintFailure, saneNow } = require('./allocation-bootstrap-store');
const { validRegisteredLabels: validLabels } = require('./runner-labels');
function unavailable() { throw new BootstrapDenied('BOOTSTRAP_UNAVAILABLE'); }
function createSecretManagerPrivateKeyProvider({ secretVersion, secretManagerClient }) {
  if (!/^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/secrets\/[A-Za-z0-9_-]{1,255}\/versions\/[1-9][0-9]{0,17}$/.test(secretVersion) ||
      !secretManagerClient || typeof secretManagerClient.accessSecretVersion !== 'function') unavailable();
  return async () => {
    try {
      const [version] = await secretManagerClient.accessSecretVersion({ name: secretVersion });
      if (!version.payload || !version.payload.data) unavailable();
      const key = Buffer.from(version.payload.data).toString('utf8');
      if (key.length < 64 || key.length > 16384) unavailable();
      return key;
    } catch (_) { unavailable(); }
  };
}
async function createGitHubAppRunnerAdapter({ appId, installationId, repositoryId,
  repositoryOwner, repositoryName, privateKeyProvider, runnerGroupId,
  jitReleaseWindowMs, clock = Date.now, octokitFactory }) {
  if (![appId, installationId, repositoryId, runnerGroupId].every(x => Number.isSafeInteger(x) && x > 0) ||
      ![repositoryOwner, repositoryName].every(x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(x)) ||
      typeof privateKeyProvider !== 'function' || !Number.isSafeInteger(jitReleaseWindowMs) ||
      jitReleaseWindowMs < 1000 || jitReleaseWindowMs > 600000) unavailable();
  let client;
  try {
    const privateKey = await privateKeyProvider();
    if (typeof privateKey !== 'string' || privateKey.length > 16384) unavailable();
    if (octokitFactory) client = await octokitFactory({ appId, installationId, privateKey, repositoryId });
    else {
      // Exact App-auth/rest versions are declared in the standalone deployment lock.
      const [{ Octokit }, { createAppAuth }] = await Promise.all([
        import('@octokit/rest'), import('@octokit/auth-app')]);
      client = new Octokit({ authStrategy: createAppAuth,
        auth: { appId, installationId, privateKey, repositoryIds: [repositoryId],
          permissions: { administration: 'write' } },
        request: { timeout: 10000 }, log: { debug() {}, info() {}, warn() {}, error() {} } });
    }
  } catch (_) { unavailable(); }
  const repoArgs = { owner: repositoryOwner, repo: repositoryName };
  async function repo() {
    const authority = await client.auth({ type: 'installation', repositoryIds: [repositoryId],
      permissions: { administration: 'write' } });
    if (!authority || authority.tokenType !== 'installation' || !authority.permissions ||
        authority.permissions.administration !== 'write') unavailable();
    const response = await client.request('GET /repos/{owner}/{repo}', repoArgs);
    if (!response.data || response.data.id !== repositoryId ||
        typeof response.data.full_name !== 'string' ||
        response.data.full_name.toLowerCase() !== `${repositoryOwner}/${repositoryName}`.toLowerCase() ||
        response.data.private !== true) unavailable();
  }
  const safe = method => async args => {
    try { await repo(); return await method(args); }
    catch (error) { if (error instanceof BootstrapMintFailure) throw error; unavailable(); }
  };
  async function inspectOwnedRunner({ runnerId, expectedName, expectedLabels }) {
    if (!Number.isSafeInteger(runnerId) || runnerId < 1 || typeof expectedName !== 'string' ||
        !validLabels(expectedLabels)) unavailable();
    let response;
    try { response = await client.request('GET /repos/{owner}/{repo}/actions/runners/{runner_id}',
      { ...repoArgs, runner_id: runnerId }); }
    catch (error) { if (error && error.status === 404) return { status: 'absent' }; unavailable(); }
    const runner = response.data;
    if (!runner || runner.id !== runnerId || runner.name !== expectedName ||
        typeof runner.busy !== 'boolean' || !Array.isArray(runner.labels) ||
        runner.labels.length !== expectedLabels.length ||
        runner.labels.some(label => !label || typeof label.name !== 'string' || !label.name) ||
        new Set(runner.labels.map(label => label.name)).size !== runner.labels.length ||
        expectedLabels.some(label => !runner.labels.some(l => l && l.name === label))) unavailable();
    return { status: 'present', busy: runner.busy };
  }
  return {
    inspectOwnedRunner: safe(inspectOwnedRunner),
    mintRegistration: safe(async () => {
      const response = await client.request('POST /repos/{owner}/{repo}/actions/runners/registration-token', repoArgs);
      const expiresAtMs = Date.parse(response.data.expires_at);
      if (typeof response.data.token !== 'string' || !response.data.token ||
          !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= saneNow(clock)) unavailable();
      // Controller API adapter only: not wired as a fallback in the one-job worker.
      return { token: response.data.token, providerExpiresAtMs: expiresAtMs };
    }),
    mintJit: safe(async ({ runnerName, labels, bootstrapExpiresAtMs }) => {
      if (!/^[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(runnerName) || !validLabels(labels) ||
          !Number.isSafeInteger(bootstrapExpiresAtMs)) unavailable();
      const response = await client.request('POST /repos/{owner}/{repo}/actions/runners/generate-jitconfig',
        { ...repoArgs, name: runnerName, runner_group_id: runnerGroupId, labels, work_folder: '_work' });
      const data = response.data;
      if (!data || !data.runner || !Number.isSafeInteger(data.runner.id) || data.runner.id <= 0 ||
          data.runner.name !== runnerName) unavailable();
      const observedRunner = { runnerId: data.runner.id, runnerName };
      try {
        if (typeof data.encoded_jit_config !== 'string' || data.encoded_jit_config.length < 1 ||
            data.encoded_jit_config.length > 65536) unavailable();
        const now = saneNow(clock);
        const releaseBeforeMs = Math.min(bootstrapExpiresAtMs, now + jitReleaseWindowMs);
        if (releaseBeforeMs <= now) unavailable();
        // Do not invent a provider lifetime from the broker's deadline. Qualification
        // must establish upstream JIT expiry. Null stays visible in durable evidence.
        let providerExpiresAtMs = null;
        if (Object.hasOwn(data, 'expires_at')) {
          providerExpiresAtMs = Date.parse(data.expires_at);
          if (!Number.isSafeInteger(providerExpiresAtMs) || providerExpiresAtMs <= now) unavailable();
        }
        return { encodedJitConfig: data.encoded_jit_config, runnerId: data.runner.id,
          runnerName, releaseBeforeMs, providerExpiresAtMs };
      } catch (_) { throw new BootstrapMintFailure(observedRunner); }
    }),
    listRunnerPage: safe(async ({ page, perPage = 100 }) => {
      if (!Number.isSafeInteger(page) || page < 1 || page > 100000 || perPage !== 100) unavailable();
      const response = await client.request('GET /repos/{owner}/{repo}/actions/runners',
        { ...repoArgs, page, per_page: perPage });
      const data = response.data;
      if (!data || !Number.isSafeInteger(data.total_count) || data.total_count < 0 ||
          !Array.isArray(data.runners) || data.runners.length > perPage) unavailable();
      const runners = data.runners.map(r => {
        if (!r || !Number.isSafeInteger(r.id) || r.id < 1 || typeof r.name !== 'string' ||
            typeof r.busy !== 'boolean' || !Array.isArray(r.labels) ||
            r.labels.some(l => !l || typeof l.name !== 'string')) unavailable();
        return { id: r.id, name: r.name, busy: r.busy,
          labels: r.labels.map(l => ({ name: l.name })) };
      });
      if (new Set(runners.map(r => r.id)).size !== runners.length) unavailable();
      return { total_count: data.total_count, runners };
    }),
    deregisterOwnedRunner: safe(async ({ runnerId, expectedName, expectedLabels }) => {
      const observed = await inspectOwnedRunner({ runnerId, expectedName, expectedLabels });
      if (observed.status === 'absent') return observed;
      if (observed.busy) return { status: 'preserved', reason: 'busy' };
      try { await client.request('DELETE /repos/{owner}/{repo}/actions/runners/{runner_id}',
        { ...repoArgs, runner_id: runnerId }); }
      catch (error) { if (!error || error.status !== 404) unavailable(); }
      const after = await inspectOwnedRunner({ runnerId, expectedName, expectedLabels });
      if (after.status === 'absent') return after;
      return { status: 'preserved', reason: 'still-present' };
    })
  };
}
module.exports = { createGitHubAppRunnerAdapter, createSecretManagerPrivateKeyProvider };
