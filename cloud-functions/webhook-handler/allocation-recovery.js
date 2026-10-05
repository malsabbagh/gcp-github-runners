'use strict';

// Independent source adaptation. No SDK imports, creation, deletion, stop,
// registration/mint or inventory-based absence inference exists in this module.
const FAILED_BUILDS = new Set(['FAILURE', 'INTERNAL_ERROR', 'TIMEOUT', 'CANCELLED', 'EXPIRED']);
const ENTRY_STATES = new Set(['submitting', 'pending', 'active', 'unknown', 'orphaned']);
const { validRoutingLabels } = require('./runner-labels');
const MAX_JSON = 1048576;
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function problem() { throw new Error('RECOVERY_INPUT_INVALID'); }
function decode(value) {
  if (typeof value !== 'string' || value.length > MAX_JSON) problem();
  const result = JSON.parse(value);
  if (!object(result)) problem();
  return result;
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  if (!['string', 'boolean', 'number'].includes(typeof value) && value !== null) problem();
  if (typeof value === 'number' && !Number.isFinite(value)) problem();
  return JSON.stringify(value);
}
function positive(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) problem();
  const text = String(value);
  if (!/^[1-9][0-9]{0,19}$/.test(text)) problem();
  return text;
}
function strictMetadata(instance) {
  if (!instance.metadata || !Array.isArray(instance.metadata.items) || instance.metadata.items.length > 100) problem();
  const result = new Map();
  for (const item of instance.metadata.items) {
    if (!item || typeof item.key !== 'string' || typeof item.value !== 'string' ||
        item.value.length > 16384 || result.has(item.key)) problem();
    result.set(item.key, item.value);
  }
  return result;
}
function emptyOptional(value) { return value === undefined || (Array.isArray(value) && value.length === 0); }
function privateIPv4(value) {
  if (typeof value !== 'string' || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return false;
  const parts = value.split('.').map(Number);
  return parts.map(String).join('.') === value && parts.every(n => n <= 255) && (parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168));
}
function proofPresence(entry, job) {
  // Presence, even malformed/unknown evidence, is enough to prohibit release.
  return ['bootstrap', 'runnerIdentity', 'cleanup', 'completion', 'association', 'recovery',
    'actualJob', 'actualCompletion', 'associationConflict', 'executedBy'].some(k => Object.hasOwn(entry, k)) ||
    ['bootstrap', 'completion', 'association', 'cleanup', 'pendingCleanup', 'bootstrapHistory',
      'actualJob', 'actualCompletion', 'associationConflict', 'executedBy'].some(k => Object.hasOwn(job, k));
}
function mirroredBootstrap(entry, job) {
  if (!Object.hasOwn(entry, 'bootstrap') && !Object.hasOwn(job, 'bootstrap')) return null;
  if (!object(entry.bootstrap) || !Object.hasOwn(job, 'bootstrap')) problem();
  const value = decode(job.bootstrap);
  if (canonical(value) !== canonical(entry.bootstrap)) problem();
  return value;
}

function createAllocationRecovery({ firestore, compute, cloudBuild, project, zone,
  repositoryOwner, repositoryName, workerServiceAccountEmail, workerServiceAccountUniqueId,
  brokerUrl, bootstrapTTLms, registeredLabels, routingLabel, identity, clock = Date.now }) {
  if (!firestore || typeof firestore.runTransaction !== 'function' ||
      !compute || typeof compute.get !== 'function' || !cloudBuild || typeof cloudBuild.getBuild !== 'function' ||
      !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project) || !/^[a-z]+(?:-[a-z]+)+[0-9]-[a-z]$/.test(zone) ||
      typeof repositoryOwner !== 'string' || typeof repositoryName !== 'string' ||
      typeof workerServiceAccountEmail !== 'string' || !/^[1-9][0-9]{5,30}$/.test(workerServiceAccountUniqueId) ||
      !Number.isSafeInteger(bootstrapTTLms) || bootstrapTTLms < 1 || bootstrapTTLms > 900000 ||
      !validRoutingLabels(registeredLabels, routingLabel)) problem();
  const url = new URL(brokerUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) problem();
  // Root composes its pure source-derived job identity helper. Injection allows
  // fixture qualification without loading the controller or initializing SDKs.
  const identify = identity || require('./job-identity').identity;
  if (typeof identify !== 'function') problem();
  const poolRef = firestore.collection('provisioning_pools').doc('global');
  const jobRef = key => firestore.collection('job_provisioning').doc(key);
  function now() {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0) problem();
    return value;
  }
  const result = (status, reason) => ({ status, reason });
  async function read(tx, key) {
    if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) problem();
    const [poolSnap, jobSnap] = await Promise.all([tx.get(poolRef), tx.get(jobRef(key))]);
    if (!poolSnap.exists || !jobSnap.exists) return null;
    const pool = poolSnap.data(); const job = jobSnap.data();
    if (!object(job) || Object.values(job).some(x => typeof x !== 'string' && typeof x !== 'boolean')) problem();
    const entries = decode(pool.entries); const entry = entries[key];
    if (!object(entry)) return null;
    if (!ENTRY_STATES.has(entry.state) || typeof entry.name !== 'string' ||
        !/^[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(entry.name) || entry.zone !== zone ||
        typeof entry.token !== 'string' || !/^[a-f0-9-]{36}$/.test(entry.token) || typeof job.done !== 'boolean') problem();
    if (entry.project !== undefined && entry.project !== project) problem();
    if (entry.buildId !== undefined && (typeof entry.buildId !== 'string' || !entry.buildId || entry.buildId.length > 256)) problem();
    const event = decode(job.event); const allocation = identify(event);
    if (!allocation || allocation.key !== key || allocation.name !== entry.name ||
        typeof event.repo_owner !== 'string' || typeof event.repo_name !== 'string' ||
        event.repo_owner.toLowerCase() !== repositoryOwner.toLowerCase() ||
        event.repo_name.toLowerCase() !== repositoryName.toLowerCase() ||
        !Array.isArray(event.labels) || !event.labels.includes('self-hosted') || !event.labels.includes(routingLabel) ||
        event.labels.some(label => typeof label !== 'string' || !registeredLabels.includes(label))) problem();
    const binding = { owner: event.repo_owner, repo: event.repo_name,
      runId: positive(event.run_id), jobId: positive(event.job_id),
      attempt: positive(event.run_attempt === undefined ? '1' : event.run_attempt) };
    return { key, entries, entry, job, binding, fingerprint: canonical({ entry, job }) };
  }
  const snapshot = key => firestore.runTransaction(tx => read(tx, key));
  function expectedOwnership(state, expected) {
    if (expected === undefined) return true; // Trusted scheduled enumeration.
    const fields = ['key', 'token', 'name', 'zone', 'project', 'instanceId', 'instanceCreationTimestamp', 'claimId'];
    if (!object(expected) || Object.keys(expected).length !== fields.length ||
        fields.some(field => !Object.hasOwn(expected, field))) return false;
    const bound = {...state.entry, key: state.key, claimId: state.entry.bootstrap?.claimId};
    return fields.every(field => typeof expected[field] === 'string' && expected[field] === bound[field]);
  }
  async function live(entry) {
    try {
      const response = await compute.get({ project, zone: entry.zone, instance: entry.name });
      if (!Array.isArray(response) || !object(response[0])) return { kind: 'unknown' };
      return { kind: 'live', instance: response[0] };
    } catch (error) {
      return error && typeof error.code === 'number' && error.code === 5 ? { kind: 'absent' } : { kind: 'unknown' };
    }
  }
  function bindingFromInstance(state, instance) {
    const e = state.entry; const b = state.binding;
    const prefix = `https://www.googleapis.com/compute/v1/projects/${project}/zones/${zone}`;
    if (instance.selfLink !== `${prefix}/instances/${e.name}` || instance.zone !== prefix ||
        instance.name !== e.name || instance.status !== 'RUNNING') problem();
    const id = positive(instance.id);
    const created = instance.creationTimestamp; const createdMs = Date.parse(created);
    if (typeof created !== 'string' || !Number.isSafeInteger(createdMs) || createdMs < 0 || createdMs > now()) problem();
    if (!instance.scheduling || instance.scheduling.provisioningModel !== 'SPOT' ||
        instance.scheduling.instanceTerminationAction !== 'DELETE' || instance.scheduling.automaticRestart !== false ||
        !Array.isArray(instance.serviceAccounts) || instance.serviceAccounts.length !== 1 ||
        instance.serviceAccounts[0].email !== workerServiceAccountEmail ||
        !Array.isArray(instance.serviceAccounts[0].scopes) || instance.serviceAccounts[0].scopes.length !== 0 ||
        !Array.isArray(instance.networkInterfaces) || instance.networkInterfaces.length !== 1) problem();
    const nic = instance.networkInterfaces[0];
    if (!nic || !privateIPv4(nic.networkIP) || typeof nic.network !== 'string' || !nic.network ||
        typeof nic.subnetwork !== 'string' || !nic.subnetwork ||
        !emptyOptional(nic.accessConfigs) || !emptyOptional(nic.ipv6AccessConfigs)) problem();
    const attrs = strictMetadata(instance);
    for (const key of attrs.keys()) if (/(?:github.*(?:token|pat|secret)|credential)/i.test(key) || key === 'docker-runner-image') problem();
    const expected = { 'allocation-key': state.key, 'reservation-token': e.token,
      'repo-owner': b.owner, 'repo-name': b.repo, 'run-id': b.runId, 'job-id': b.jobId,
      'run-attempt': b.attempt, 'vm-id': e.name, 'allocation-broker-url': brokerUrl,
      'runner-count': '1', 'worker-profile': 'trusted-private-one-job' };
    for (const [key, value] of Object.entries(expected)) if (attrs.get(key) !== value) problem();
    const text = attrs.get('bootstrap-expires-at-ms');
    if (typeof text !== 'string' || !/^[1-9][0-9]{0,15}$/.test(text)) problem();
    const expiry = Number(text);
    if (!Number.isSafeInteger(expiry) || expiry < createdMs || expiry > createdMs + bootstrapTTLms ||
        (e.bootstrapExpiresAtMs !== undefined && e.bootstrapExpiresAtMs !== expiry)) problem();
    const fields = { instanceId: id, instanceCreationTimestamp: created, project, brokerUrl,
      workerServiceAccountEmail, workerServiceAccountUniqueId, bootstrapExpiresAtMs: expiry };
    for (const [key, value] of Object.entries(fields)) if (e[key] !== undefined && e[key] !== value) problem();
    return fields;
  }
  async function markEvidence(state, reason) {
    return firestore.runTransaction(async tx => {
      const current = await read(tx, state.key);
      if (!current || current.fingerprint !== state.fingerprint) return result('preserved', 'ownership-changed');
      const receipt = mirroredBootstrap(current.entry, current.job);
      const known = receipt && receipt.version === 1 && ['claimed', 'issued'].includes(receipt.state) &&
        typeof receipt.claimId === 'string' && receipt.claimId.length > 0 &&
        typeof current.entry.instanceId === 'string' && /^[1-9][0-9]{0,19}$/.test(current.entry.instanceId) &&
        typeof current.entry.instanceCreationTimestamp === 'string' && Number.isFinite(Date.parse(current.entry.instanceCreationTimestamp)) &&
        receipt.expiresAtMs === current.entry.bootstrapExpiresAtMs && receipt.mintOutcome === 'observed' &&
        Number.isSafeInteger(receipt.runnerId) && receipt.runnerId > 0 && receipt.runnerName === current.entry.name &&
        validRoutingLabels(receipt.runnerLabels, routingLabel);
      const next = { ...current.entry, state: known ? 'orphaned' : 'unknown', recovery: {
        version: 1, state: known ? 'orphaned' : 'unknown', reason,
        instanceId: current.entry.instanceId || null,
        instanceCreationTimestamp: current.entry.instanceCreationTimestamp || null,
        reservationToken: current.entry.token, buildId: current.entry.buildId || null,
        observedAtMs: now() } };
      tx.update(poolRef, { entries: JSON.stringify({ ...current.entries, [current.key]: next }) });
      return result('preserved', known ? 'known-runner-orphan-charged' : 'receipt-or-association-charged');
    });
  }
  return {
    async hydrateAllocation(key, expected) {
      try {
        const startedAt = now();
        const state = await snapshot(key);
        if (!state) return result('preserved', 'allocation-unavailable');
        if (!expectedOwnership(state, expected)) return result('preserved', 'request-ownership-changed');
        const observed = await live(state.entry);
        if (observed.kind === 'absent') return result('absent', 'authoritative-get-not-found');
        if (observed.kind !== 'live') return result('preserved', 'compute-inspection-unknown');
        // Receipt or association state belongs to lifecycle, never a hydration
        // path that might re-enable an old allocation's issuance.
        if (proofPresence(state.entry, state.job)) return result('preserved', 'receipt-or-association-present');
        const fields = bindingFromInstance(state, observed.instance);
        const observedAt = now();
        if (observedAt < startedAt) return result('preserved', 'clock-unverified');
        if (fields.bootstrapExpiresAtMs <= now()) return result('preserved', 'bootstrap-expired-no-extension');
        return await firestore.runTransaction(async tx => {
          const current = await read(tx, key);
          if (!current || current.fingerprint !== state.fingerprint) return result('preserved', 'ownership-changed');
          if (proofPresence(current.entry, current.job)) return result('preserved', 'receipt-or-association-present');
          if (now() < observedAt) return result('preserved', 'clock-unverified');
          if (fields.bootstrapExpiresAtMs <= now()) return result('preserved', 'bootstrap-expired-no-extension');
          const next = { ...current.entry, ...fields, state: 'active' };
          if (current.job.done || current.entry.demandDone === true) next.demandDone = true;
          if (canonical(next) === canonical(current.entry)) return result('hydrated', 'already-bound');
          tx.update(poolRef, { entries: JSON.stringify({ ...current.entries, [key]: next }) });
          return result('hydrated', 'authoritative-incarnation-bound');
        });
      } catch (_) { return result('preserved', 'binding-or-state-unverified'); }
    },
    async recoverAbsentAllocation(key, expected) {
      try {
        const state = await snapshot(key);
        if (!state) return result('preserved', 'allocation-unavailable');
        if (!expectedOwnership(state, expected)) return result('preserved', 'request-ownership-changed');
        const observed = await live(state.entry);
        if (observed.kind !== 'absent') return result('preserved', observed.kind === 'live' ? 'instance-present' : 'compute-inspection-unknown');
        if (proofPresence(state.entry, state.job)) return await markEvidence(state, 'authoritative-vm-absence');
        // A failed build can leave a previously accepted Compute insertion in
        // flight. Only an explicit durable no-attempt flag permits this release.
        // Missing legacy flags and true flags never imply definitive absence.
        if (state.entry.creationStarted !== false) return result('preserved', 'compute-creation-outcome-unknown');
        if (typeof state.entry.buildId !== 'string' || !state.entry.buildId) return result('preserved', 'submission-ownership-unknown');
        let response;
        try { response = await cloudBuild.getBuild({ projectId: project, id: state.entry.buildId }); }
        catch (_) { return result('preserved', 'build-inspection-unknown'); }
        const build = Array.isArray(response) && response[0];
        if (!build || build.id !== state.entry.buildId || build.projectId !== project || !FAILED_BUILDS.has(build.status))
          return result('preserved', 'accepted-or-unknown-build-charged');
        // No provider side effect follows. A second exact GET narrows the read
        // race; it cannot make Compute and Firestore an atomic transaction.
        if ((await live(state.entry)).kind !== 'absent') return result('preserved', 'absence-no-longer-confirmed');
        return await firestore.runTransaction(async tx => {
          const current = await read(tx, key);
          if (!current || current.fingerprint !== state.fingerprint) return result('preserved', 'ownership-changed');
          if (proofPresence(current.entry, current.job)) return result('preserved', 'receipt-or-association-present');
          if (current.entry.creationStarted !== false) return result('preserved', 'compute-creation-outcome-unknown');
          const entries = { ...current.entries }; delete entries[key];
          tx.update(poolRef, { entries: JSON.stringify(entries) });
          tx.update(jobRef(key), { state: current.job.done ? 'completed' : 'waiting' });
          return result('released', 'failed-build-and-authoritative-absence-unissued');
        });
      } catch (_) { return result('preserved', 'binding-or-state-unverified'); }
    }
  };
}
module.exports = { createAllocationRecovery, strictMetadata };
