'use strict';
const { validRoutingLabels } = require('./runner-labels');

// New adaptation: only the canonical pool and existing demand document are used.
// Do not instantiate a second Firestore database or allocation collection here.
const CODES = new Set(['BOOTSTRAP_INVALID', 'BOOTSTRAP_UNAVAILABLE',
  'BOOTSTRAP_BINDING_REJECTED', 'BOOTSTRAP_EXPIRED', 'BOOTSTRAP_REPLAY_REJECTED',
  'BOOTSTRAP_IDENTITY_REJECTED', 'BOOTSTRAP_COMMIT_REJECTED']);
class BootstrapDenied extends Error {
  constructor(code) {
    const safe = CODES.has(code) ? code : 'BOOTSTRAP_UNAVAILABLE';
    super(safe); this.code = safe;
  }
}
// Carry only the observed, ownership-checked runner identity across an adapter
// rejection. Provider material and private diagnostics never enter this error.
class BootstrapMintFailure extends BootstrapDenied {
  constructor({ runnerId, runnerName }) {
    super('BOOTSTRAP_UNAVAILABLE');
    if (!Number.isSafeInteger(runnerId) || runnerId <= 0 ||
        typeof runnerName !== 'string' || !/^[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(runnerName))
      throw new BootstrapDenied('BOOTSTRAP_UNAVAILABLE');
    this.observedRunner = Object.freeze({ runnerId, runnerName });
  }
}
function deny(code) { throw new BootstrapDenied(code); }
function redactedBootstrapCode(error) {
  return error instanceof BootstrapDenied && CODES.has(error.code) ? error.code : 'BOOTSTRAP_UNAVAILABLE';
}
function saneNow(clock) {
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0) deny('BOOTSTRAP_UNAVAILABLE');
  return now;
}
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function decode(text) {
  if (typeof text !== 'string' || text.length > 1048576) deny('BOOTSTRAP_UNAVAILABLE');
  let value;
  try { value = JSON.parse(text); } catch (_) { deny('BOOTSTRAP_UNAVAILABLE'); }
  if (!object(value)) deny('BOOTSTRAP_UNAVAILABLE');
  return value;
}
function positiveId(value) {
  const text = String(value);
  if (!/^[1-9][0-9]{0,19}$/.test(text)) deny('BOOTSTRAP_INVALID');
  return text;
}
function eventBinding(event) {
  if (!object(event) || typeof event.repo_owner !== 'string' ||
      typeof event.repo_name !== 'string' || !Array.isArray(event.labels) ||
      event.labels.some(label => typeof label !== 'string')) deny('BOOTSTRAP_UNAVAILABLE');
  return { repositoryOwner: event.repo_owner, repositoryName: event.repo_name,
    runId: positiveId(event.run_id), jobId: positiveId(event.job_id),
    // Match the existing durable event convention; request attempts never default.
    attempt: positiveId(event.run_attempt === undefined ? '1' : event.run_attempt),
    labels: event.labels };
}
function assertRequest(request) {
  const keys = ['allocationKey', 'reservationToken', 'repositoryOwner',
    'repositoryName', 'runId', 'jobId', 'attempt', 'instanceId'];
  if (!object(request) || Object.keys(request).length !== keys.length ||
      keys.some(k => !Object.hasOwn(request, k) || typeof request[k] !== 'string') ||
      !/^[a-f0-9]{64}$/.test(request.allocationKey) ||
      !/^[a-f0-9-]{36}$/.test(request.reservationToken) ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(request.repositoryOwner) ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(request.repositoryName)) deny('BOOTSTRAP_INVALID');
  for (const k of ['runId', 'jobId', 'attempt', 'instanceId']) positiveId(request[k]);
}

function createAllocationBootstrapStore({ firestore, project, zone,
  repositoryOwner, repositoryName, workerServiceAccountEmail,
  workerServiceAccountUniqueId, registeredLabels, routingLabel, clock = Date.now }) {
  if (!firestore || typeof firestore.runTransaction !== 'function' ||
      typeof project !== 'string' || typeof zone !== 'string' ||
      typeof repositoryOwner !== 'string' || typeof repositoryName !== 'string' ||
      typeof workerServiceAccountEmail !== 'string' ||
      !/^[0-9]{6,32}$/.test(workerServiceAccountUniqueId) ||
      !validRoutingLabels(registeredLabels, routingLabel)) deny('BOOTSTRAP_INVALID');
  const poolRef = firestore.collection('provisioning_pools').doc('global');
  const read = async (tx, request, evidenceOnly = false) => {
    assertRequest(request);
    const jobRef = firestore.collection('job_provisioning').doc(request.allocationKey);
    // Read every authoritative record before any transaction writes.
    const [poolSnap, jobSnap] = await Promise.all([tx.get(poolRef), tx.get(jobRef)]);
    if (!poolSnap.exists || !jobSnap.exists) deny('BOOTSTRAP_UNAVAILABLE');
    const pool = poolSnap.data(); const job = jobSnap.data();
    const entries = decode(pool.entries); const entry = entries[request.allocationKey];
    if (!object(entry) || typeof job.done !== 'boolean' || (!evidenceOnly &&
        (job.done !== false || entry.demandDone === true ||
        ['completed', 'cancelled', 'retiring'].includes(job.state) ||
        entry.state !== 'active'))) deny('BOOTSTRAP_UNAVAILABLE');
    const binding = eventBinding(decode(job.event));
    if (binding.repositoryOwner.toLowerCase() !== repositoryOwner.toLowerCase() ||
        binding.repositoryName.toLowerCase() !== repositoryName.toLowerCase() ||
        ['repositoryOwner', 'repositoryName', 'runId', 'jobId', 'attempt'].some(k => binding[k] !== request[k]) ||
        !binding.labels.includes('self-hosted') || !binding.labels.includes(routingLabel) ||
        binding.labels.some(label => !registeredLabels.includes(label)) ||
        entry.token !== request.reservationToken || entry.instanceId !== request.instanceId ||
        entry.project !== project || entry.zone !== zone ||
        entry.workerServiceAccountEmail !== workerServiceAccountEmail ||
        entry.workerServiceAccountUniqueId !== workerServiceAccountUniqueId ||
        typeof entry.name !== 'string' || !/^[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(entry.name) ||
        typeof entry.instanceCreationTimestamp !== 'string' ||
        !Number.isFinite(Date.parse(entry.instanceCreationTimestamp))) deny('BOOTSTRAP_BINDING_REJECTED');
    const now = saneNow(clock);
    if (!Number.isSafeInteger(entry.bootstrapExpiresAtMs) || (!evidenceOnly && entry.bootstrapExpiresAtMs <= now))
      deny('BOOTSTRAP_EXPIRED');
    const bootstrap = entry.bootstrap === undefined ? null : entry.bootstrap;
    const jobBootstrap = job.bootstrap === undefined ? null : decode(job.bootstrap);
    if (JSON.stringify(bootstrap) !== JSON.stringify(jobBootstrap)) deny('BOOTSTRAP_COMMIT_REJECTED');
    return { poolRef, jobRef, entries, entry, bootstrap, now, binding,
      allocation: { ...binding, allocationKey: request.allocationKey, reservationToken: entry.token,
        name: entry.name, project, zone, instanceId: entry.instanceId,
        incarnation: entry.instanceCreationTimestamp, workerServiceAccountEmail,
        workerServiceAccountUniqueId, bootstrapExpiresAtMs: entry.bootstrapExpiresAtMs,
        registeredLabels: [...registeredLabels] } };
  };
  function identityMatches(state, identity) {
    const a = state.allocation;
    if (!identity || identity.project !== a.project || identity.zone !== a.zone ||
        identity.name !== a.name || identity.instanceId !== a.instanceId ||
        identity.incarnation !== a.incarnation ||
        identity.serviceAccountEmail !== a.workerServiceAccountEmail ||
        identity.serviceAccountUniqueId !== a.workerServiceAccountUniqueId ||
        !Number.isSafeInteger(identity.checkedAtMs) || state.now < identity.checkedAtMs ||
        !Number.isSafeInteger(identity.expiresAtMs) || identity.expiresAtMs <= state.now)
      deny('BOOTSTRAP_IDENTITY_REJECTED');
  }
  function writeBootstrap(tx, state, bootstrap, runnerIdentity) {
    const next = { ...state.entry, bootstrap };
    if (runnerIdentity) next.runnerIdentity = runnerIdentity;
    const entries = { ...state.entries, [state.allocation.allocationKey]: next };
    tx.update(state.poolRef, { entries: JSON.stringify(entries) });
    // Python's current job decoder accepts strings/bools only. Keep this a string.
    tx.update(state.jobRef, { bootstrap: JSON.stringify(bootstrap) });
  }
  return {
    async readBootstrapAllocation(request) {
      return firestore.runTransaction(async tx => (await read(tx, request)).allocation);
    },
    async claimBootstrap(request, identity, claimId) {
      if (typeof claimId !== 'string' || !/^[a-f0-9-]{36}$/.test(claimId)) deny('BOOTSTRAP_INVALID');
      return firestore.runTransaction(async tx => {
        const state = await read(tx, request); identityMatches(state, identity);
        if (state.bootstrap !== null) deny('BOOTSTRAP_REPLAY_REJECTED');
        const bootstrap = { version: 1, state: 'claimed', claimId, claimedAtMs: state.now,
          expiresAtMs: state.entry.bootstrapExpiresAtMs };
        writeBootstrap(tx, state, bootstrap);
        return { ...state.allocation, claimId, claimedAtMs: state.now };
      });
    },
    async recordBootstrapMintEvidence(request, claimId, material) {
      return firestore.runTransaction(async tx => {
        // Cancellation/expiry must not discard known provider orphan identity.
        // This path cannot claim, release material, reset issuance or free capacity.
        const state = await read(tx, request, true); const b = state.bootstrap;
        if (!object(b) || b.state !== 'claimed' || b.claimId !== claimId ||
            !material || !Number.isSafeInteger(material.runnerId) || material.runnerId <= 0 ||
            material.runnerName !== state.entry.name ||
            (b.runnerId !== undefined && b.runnerId !== material.runnerId))
          deny('BOOTSTRAP_COMMIT_REJECTED');
        const evidence = { ...b, runnerId: material.runnerId,
          runnerName: material.runnerName, runnerLabels: [...registeredLabels], mintOutcome: 'observed' };
        if (Number.isSafeInteger(material.releaseBeforeMs)) evidence.releaseBeforeMs = material.releaseBeforeMs;
        if (material.providerExpiresAtMs === null || Number.isSafeInteger(material.providerExpiresAtMs))
          evidence.providerExpiresAtMs = material.providerExpiresAtMs;
        writeBootstrap(tx, state, evidence);
      });
    },
    async commitBootstrapReceipt(request, identity, claimId, material, earliestNow) {
      return firestore.runTransaction(async tx => {
        const state = await read(tx, request); identityMatches(state, identity);
        const b = state.bootstrap;
        if (!material || state.now < earliestNow || !object(b) || b.version !== 1 || b.state !== 'claimed' ||
            b.claimId !== claimId || b.expiresAtMs !== state.entry.bootstrapExpiresAtMs ||
            b.runnerId !== material.runnerId || b.runnerName !== material.runnerName ||
            !Number.isSafeInteger(material.releaseBeforeMs) ||
            material.releaseBeforeMs <= state.now ||
            (material.providerExpiresAtMs !== null &&
              (!Number.isSafeInteger(material.providerExpiresAtMs) || material.providerExpiresAtMs <= state.now)) ||
            !Number.isSafeInteger(material.runnerId) ||
            material.runnerId <= 0 || material.runnerName !== state.entry.name)
          deny('BOOTSTRAP_COMMIT_REJECTED');
        const runnerIdentity = { id: material.runnerId, name: material.runnerName,
          labels: [...registeredLabels] };
        writeBootstrap(tx, state, { ...b, state: 'issued', issuedAtMs: state.now,
          releaseBeforeMs: material.releaseBeforeMs,
          providerExpiresAtMs: material.providerExpiresAtMs, runnerId: material.runnerId,
          runnerName: material.runnerName }, runnerIdentity);
        return { allocationKey: request.allocationKey, instanceId: state.entry.instanceId,
          incarnation: state.entry.instanceCreationTimestamp, runnerIdentity };
      });
    }
  };
}
module.exports = { BootstrapDenied, BootstrapMintFailure, redactedBootstrapCode, assertRequest, saneNow, createAllocationBootstrapStore };
