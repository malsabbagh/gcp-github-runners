'use strict';
// Independently authored actual dispatch observation. No SDK/provider side effects.
// The caller must set verifiedWebhook only after authenticating exact webhook bytes.
const { identity } = require('./job-identity');
const MAX_POOL_BYTES = 1048576;
const MAX_ENTRIES = 1000;
const recordKeys = ['version', 'key', 'repositoryOwner', 'repositoryName', 'runId',
  'jobId', 'runAttempt', 'runnerId', 'runnerName', 'claimId', 'reservationToken',
  'instanceId', 'instanceCreationTimestamp', 'state', 'verifiedWebhook', 'observedAtMs'];
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function parseObject(text) {
  if (typeof text !== 'string' || text.length > MAX_POOL_BYTES) throw Error('ASSOCIATION_STATE_UNKNOWN');
  const value = JSON.parse(text);
  if (!object(value)) throw Error('ASSOCIATION_STATE_UNKNOWN');
  return value;
}
function positive(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw Error('ASSOCIATION_INVALID');
  const text = String(value);
  if (!/^[1-9][0-9]*$/.test(text) || text.length > 32) throw Error('ASSOCIATION_INVALID');
  return text;
}
function equal(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) &&
    a.length === b.length && a.every((value, i) => equal(value, b[i]));
  if (!object(a) || !object(b)) return false;
  const ak = Object.keys(a).sort(), bk = Object.keys(b).sort();
  return ak.length === bk.length && ak.every((key, i) => key === bk[i] &&
    equal(a[key], b[key]));
}
function issuedBinding(entry, job) {
  if (!object(entry) || !object(job) || typeof job.done !== 'boolean' || !['active', 'retiring', 'orphaned'].includes(entry.state) ||
      !object(entry.runnerIdentity) || !object(entry.bootstrap) ||
      !Number.isSafeInteger(entry.runnerIdentity.id) || entry.runnerIdentity.id < 1 ||
      !Number.isSafeInteger(entry.bootstrap.runnerId) || entry.bootstrap.runnerId < 1 ||
      entry.bootstrap.version !== 1 || entry.bootstrap.state !== 'issued' ||
      typeof entry.bootstrap.claimId !== 'string' || !/^[a-f0-9-]{36}$/.test(entry.bootstrap.claimId) ||
      typeof entry.token !== 'string' || !/^[a-f0-9-]{36}$/.test(entry.token) ||
      typeof entry.name !== 'string' || !/^[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(entry.name) ||
      typeof entry.instanceCreationTimestamp !== 'string' ||
      !Number.isFinite(Date.parse(entry.instanceCreationTimestamp))) throw Error('ASSOCIATION_BINDING_UNKNOWN');
  const runnerId = positive(entry.runnerIdentity.id);
  if (entry.runnerIdentity.name !== entry.name || entry.bootstrap.runnerName !== entry.name ||
      positive(entry.bootstrap.runnerId) !== runnerId ||
      !equal(entry.bootstrap, parseObject(job.bootstrap))) throw Error('ASSOCIATION_BINDING_UNKNOWN');
  return { runnerId, runnerName: entry.name, claimId: entry.bootstrap.claimId,
    reservationToken: entry.token, instanceId: positive(entry.instanceId),
    instanceCreationTimestamp: entry.instanceCreationTimestamp };
}
function canonicalActual(record, binding) {
  if (!object(record) || Object.keys(record).length !== recordKeys.length ||
      recordKeys.some(key => !Object.hasOwn(record, key)) || record.version !== 1 ||
      record.verifiedWebhook !== true || !['running', 'completed'].includes(record.state) ||
      !Number.isSafeInteger(record.observedAtMs) || record.observedAtMs < 0 ||
      ['runId', 'jobId', 'runAttempt', 'runnerId', 'instanceId'].some(key => typeof record[key] !== 'string') ||
      Object.keys(binding).some(key => record[key] !== binding[key])) return false;
  try {
    for (const key of ['runId', 'jobId', 'runAttempt', 'runnerId', 'instanceId']) positive(record[key]);
    return identity({ repo_owner: record.repositoryOwner, repo_name: record.repositoryName,
      run_id: record.runId, job_id: record.jobId, run_attempt: record.runAttempt }).key === record.key;
  } catch (_) { return false; }
}
function validatedActualCompletion({ entry, job }) {
  try {
    if (entry?.associationConflict || job?.associationConflict) return false;
    const binding = issuedBinding(entry, job);
    const actual = entry.actualJob;
    const ownerEvent = parseObject(job.event);
    if (typeof ownerEvent.repo_owner !== 'string' || typeof ownerEvent.repo_name !== 'string' ||
        typeof actual?.repositoryOwner !== 'string' || typeof actual?.repositoryName !== 'string' ||
        ownerEvent.repo_owner.toLowerCase() !== actual.repositoryOwner.toLowerCase() ||
        ownerEvent.repo_name.toLowerCase() !== actual.repositoryName.toLowerCase()) return false;
    return canonicalActual(actual, binding) && actual.state === 'completed' &&
      equal(actual, parseObject(job.actualJob)) && equal(actual, parseObject(job.actualCompletion));
  } catch (_) { return false; }
}
function ownership(entry) {
  return JSON.stringify([entry.token, entry.name, entry.zone, entry.project,
    entry.instanceId, entry.instanceCreationTimestamp, entry.bootstrap?.claimId,
    entry.runnerIdentity?.id, entry.runnerIdentity?.name]);
}
function createActualJobAssociation({ firestore, repositoryOwner, repositoryName, clock = Date.now }) {
  if (!firestore || typeof firestore.runTransaction !== 'function' ||
      typeof repositoryOwner !== 'string' || typeof repositoryName !== 'string') throw Error('ASSOCIATION_INVALID');
  const poolRef = firestore.collection('provisioning_pools').doc('global');
  const jobRef = key => firestore.collection('job_provisioning').doc(key);
  async function observe(event) {
    let actualKey, runnerId, now;
    try {
      if (!object(event) || event.verifiedWebhook !== true ||
          !['in_progress', 'completed'].includes(event.action)) return { status: 'ignored', reason: 'unsupported_or_unverified' };
      if (typeof event.repo_owner !== 'string' || typeof event.repo_name !== 'string' ||
          event.repo_owner.toLowerCase() !== repositoryOwner.toLowerCase() ||
          event.repo_name.toLowerCase() !== repositoryName.toLowerCase()) return { status: 'ignored', reason: 'repository_outside_scope' };
      actualKey = identity(event).key;
      runnerId = positive(event.runner_id);
      if (typeof event.runner_name !== 'string' || !/^[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(event.runner_name)) throw Error('ASSOCIATION_INVALID');
      now = clock();
      if (!Number.isSafeInteger(now) || now < 0) throw Error('ASSOCIATION_INVALID');
    } catch (_) { return { status: 'ignored', reason: 'invalid_event' }; }
    // Firestore may rerun this callback. Never transfer the observation to a
    // different reservation/incarnation merely because the transaction retried.
    let initialOwnership;
    try {
      return await firestore.runTransaction(async tx => {
        const poolSnap = await tx.get(poolRef);
        if (!poolSnap.exists) return { status: 'preserved', reason: 'pool_missing' };
        const pool = poolSnap.data(), entries = parseObject(pool.entries);
        const rows = Object.entries(entries);
        if (rows.length > MAX_ENTRIES || rows.some(([key, entry]) => !/^[a-f0-9]{64}$/.test(key) || !object(entry)))
          return { status: 'preserved', reason: 'pool_unknown' };
        const candidates = rows.filter(([, entry]) => {
          const ids = [entry.runnerIdentity?.id, entry.bootstrap?.runnerId];
          return ids.some(id => id !== undefined && String(id) === runnerId) ||
            entry.name === event.runner_name ||
            entry.runnerIdentity?.name === event.runner_name || entry.bootstrap?.runnerName === event.runner_name ||
            entry.actualJob?.key === actualKey;
        });
        if (!candidates.length) return { status: 'preserved', reason: 'issued_runner_not_found' };
        const currentOwnership = JSON.stringify(candidates.map(([key, entry]) => [key, ownership(entry)]).sort());
        if (initialOwnership === undefined) initialOwnership = currentOwnership;
        else if (initialOwnership !== currentOwnership) return { status: 'preserved', reason: 'ownership_changed' };
        // Read every owner demand AND the actual demand before any write.
        const keys = [...new Set([...candidates.map(([key]) => key), actualKey])];
        const snapshots = await Promise.all(keys.map(key => tx.get(jobRef(key))));
        const jobs = new Map(keys.map((key, i) => [key, snapshots[i].exists ? snapshots[i].data() : null]));
        function conflict(reason) {
          const evidence = { version: 1, reason, actualJobKey: actualKey,
            runnerId, runnerName: event.runner_name, observedAtMs: now, verifiedWebhook: true };
          const changed = { ...entries };
          for (const [key, entry] of candidates) {
            const proof = entry.associationConflict || evidence;
            changed[key] = { ...entry, associationConflict: proof };
            const job = jobs.get(key);
            if (job) tx.set(jobRef(key), { ...job,
              associationConflict: job.associationConflict || JSON.stringify(proof) });
          }
          tx.set(poolRef, { ...pool, entries: JSON.stringify(changed) });
          return { status: 'conflict', reason };
        }
        if (candidates.length !== 1) return conflict('ambiguous_runner_or_actual_job');
        const [allocationKey, entry] = candidates[0], job = jobs.get(allocationKey);
        if (entry.associationConflict || job?.associationConflict) return { status: 'conflict', reason: 'prior_conflict' };
        let binding;
        try {
          binding = issuedBinding(entry, job);
          const ownerEvent = parseObject(job.event);
          if (identity(ownerEvent).key !== allocationKey ||
              ownerEvent.repo_owner.toLowerCase() !== repositoryOwner.toLowerCase() ||
              ownerEvent.repo_name.toLowerCase() !== repositoryName.toLowerCase() ||
              binding.runnerId !== runnerId || binding.runnerName !== event.runner_name) throw Error('ASSOCIATION_BINDING_UNKNOWN');
        } catch (_) { return conflict('issued_ownership_unknown'); }
        const proposed = { version: 1, key: actualKey, repositoryOwner: event.repo_owner,
          repositoryName: event.repo_name, runId: positive(event.run_id), jobId: positive(event.job_id),
          runAttempt: positive(event.run_attempt || '1'), ...binding,
          state: event.action === 'completed' ? 'completed' : 'running',
          verifiedWebhook: true, observedAtMs: now };
        // Demand execution and this demand's own VM executing some other job are
        // independent axes. Only executedBy is the reverse execution pointer.
        const actualDemand = jobs.get(actualKey);
        const pointerFor = actual => ({ version: 1, allocationKey, actualJobKey: actual.key,
          reservationToken: actual.reservationToken, instanceId: actual.instanceId,
          instanceCreationTimestamp: actual.instanceCreationTimestamp,
          runnerId: actual.runnerId, runnerName: actual.runnerName,
          claimId: actual.claimId, state: actual.state });
        let previousPointer;
        if (actualDemand?.executedBy !== undefined) {
          try {
            previousPointer = parseObject(actualDemand.executedBy);
            const expected = pointerFor(proposed);
            if (!['running', 'completed'].includes(previousPointer.state) ||
                !equal({ ...previousPointer, state: expected.state }, expected))
              return conflict('actual_demand_already_executed_elsewhere');
          } catch (_) { return conflict('actual_demand_execution_unknown'); }
        }
        let status = proposed.state === 'completed' ? 'completed' : 'associated';
        let actual = proposed;
        if (entry.actualJob !== undefined || job.actualJob !== undefined || job.actualCompletion !== undefined) {
          let previous;
          try {
            previous = entry.actualJob;
            if (!canonicalActual(previous, binding) || !equal(previous, parseObject(job.actualJob)) ||
                previous.key !== proposed.key || ['repositoryOwner', 'repositoryName', 'runId', 'jobId', 'runAttempt']
                  .some(key => previous[key] !== proposed[key]) ||
                (job.actualCompletion !== undefined && (!equal(previous, parseObject(job.actualCompletion)) || previous.state !== 'completed')))
              return conflict('different_or_corrupt_actual_job');
          } catch (_) { return conflict('different_or_corrupt_actual_job'); }
          if (previousPointer && previousPointer.state !== previous.state)
            return conflict('execution_pointer_state_conflict');
          if (previous.state === 'completed' || proposed.state === 'running') {
            actual = previous;
            status = 'duplicate';
          }
        } else if (previousPointer) {
          return conflict('execution_pointer_without_owner_binding');
        }
        const pointer = pointerFor(actual);
        // A duplicate with its reverse receipt present has no write side effect.
        if (status === 'duplicate' && previousPointer) return { status, allocationKey, actualJobKey: actualKey };
        const next = { ...job, actualJob: JSON.stringify(actual) };
        if (actual.state === 'completed') next.actualCompletion = JSON.stringify(actual);
        if (actualKey === allocationKey) next.executedBy = JSON.stringify(pointer);
        tx.set(jobRef(allocationKey), next);
        if (actualKey !== allocationKey) {
          const demand = actualDemand || { done: false, state: 'running',
            event: JSON.stringify({ repo_owner: event.repo_owner, repo_name: event.repo_name,
              run_id: event.run_id, job_id: event.job_id, run_attempt: event.run_attempt || '1',
              labels: event.labels || [], verifiedWebhook: true }) };
          tx.set(jobRef(actualKey), { ...demand, executedBy: JSON.stringify(pointer) });
        }
        tx.set(poolRef, { ...pool, entries: JSON.stringify({ ...entries,
          [allocationKey]: { ...entry, actualJob: actual } }) });
        return { status, allocationKey, actualJobKey: actualKey };
      });
    } catch (_) { return { status: 'preserved', reason: 'association_state_unavailable' }; }
  }
  return { observe };
}
module.exports = { createActualJobAssociation, validatedActualCompletion };
