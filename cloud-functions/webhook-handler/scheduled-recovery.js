'use strict';
const {authorityConfiguration, principalRole, validRequest} = require('./management-http');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function createScheduledRecovery({firestore, recovery, retirement, dispatcher, enabled = false, batchSize = 20,
                                  authenticateInvocation = async () => null, ...authority}) {
  const configuration = enabled === true ? authorityConfiguration(authority) : null;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100 ||
      typeof authenticateInvocation !== 'function') throw Error('SCHEDULED_CONFIGURATION_INVALID');
  // This is only scheduling composition. Exact incarnation/build recovery and
  // lifecycle ownership decisions stay in the existing canonical components.
  const poolRef = () => firestore.collection('provisioning_pools').doc('global');
  const jobRef = key => firestore.collection('job_provisioning').doc(key);
  const cursorRef = () => firestore.collection('provisioning_cursors').doc('management');
  const preserved = () => ({status: 'preserved'});
  function entriesFrom(pool) {
    if (!object(pool) || typeof pool.entries !== 'string' || pool.entries.length > 1048576) throw Error('SCHEDULED_STATE_UNKNOWN');
    const entries = JSON.parse(pool.entries);
    if (!object(entries) || Object.keys(entries).length > 10000 ||
        Object.entries(entries).some(([key, entry]) => !/^[a-f0-9]{64}$/.test(key) || !object(entry)))
      throw Error('SCHEDULED_STATE_UNKNOWN');
    return entries;
  }
  async function nextBatch() {
    return firestore.runTransaction(async tx => {
      const [pool, cursor] = await Promise.all([tx.get(poolRef()), tx.get(cursorRef())]);
      if (!pool.exists) return [];
      const entries = entriesFrom(pool.data());
      const after = cursor.exists ? cursor.data().after : '';
      if (typeof after !== 'string' || after !== '' && !/^[a-f0-9]{64}$/.test(after)) throw Error('SCHEDULED_CURSOR_UNKNOWN');
      const all = Object.keys(entries).sort();
      const batch = [...all.filter(key => key > after), ...all.filter(key => key <= after)].slice(0, batchSize);
      // Read all selected original-demand documents before writing the cursor.
      // Existing receipt/association data is never rewritten by this scheduler.
      await Promise.all(batch.map(key => tx.get(jobRef(key))));
      if (batch.length) tx.set(cursorRef(), {after: batch[batch.length - 1]});
      return batch;
    });
  }
  async function currentEntry(key) {
    return firestore.runTransaction(async tx => {
      const [pool, job] = await Promise.all([tx.get(poolRef()), tx.get(jobRef(key))]);
      if (!pool.exists || !job.exists) return null;
      const entry = entriesFrom(pool.data())[key], data = job.data();
      if (!entry || !object(data) || Object.values(data).some(value => typeof value !== 'string' && typeof value !== 'boolean'))
        return null;
      return entry;
    });
  }
  function ownershipRequest(key, entry) {
    if (!entry) return null;
    const request = {key, token: entry.token, name: entry.name, zone: entry.zone, project: entry.project,
      instanceId: entry.instanceId, instanceCreationTimestamp: entry.instanceCreationTimestamp,
      claimId: entry.bootstrap?.claimId};
    return validRequest(request) ? request : null;
  }
  async function unchangedRequest(request) {
    const latest = ownershipRequest(request.key, await currentEntry(request.key));
    return latest && Object.keys(request).every(key => latest[key] === request[key]) ? latest : null;
  }
  return {
    async runScheduled(invocation) {
      if (enabled !== true) return {status: 'disabled'};
      try {
        if (!principalRole(await authenticateInvocation(invocation), configuration)) return {status: 'denied'};
        if (!firestore || typeof firestore.runTransaction !== 'function' || !recovery ||
            typeof recovery.hydrateAllocation !== 'function' || typeof recovery.recoverAbsentAllocation !== 'function')
          return preserved();
        const keys = await nextBatch(); let failures = 0;
        for (const key of keys) {
          try {
            const outcome = await recovery.hydrateAllocation(key);
            if (!object(outcome) || !['hydrated', 'absent', 'preserved'].includes(outcome.status))
              throw Error('SCHEDULED_RECOVERY_UNKNOWN');
            if (outcome.status === 'absent') {
              const recovered = await recovery.recoverAbsentAllocation(key);
              if (!object(recovered) || !['released', 'preserved'].includes(recovered.status))
                throw Error('SCHEDULED_RECOVERY_UNKNOWN');
            }
            const entry = await currentEntry(key);
            if (!entry) continue;
            let request = ownershipRequest(key, entry);
            // Unknown incarnation/claim is not invented or passed to an adapter.
            if (!request || !retirement) continue;
            if (entry.state === 'orphaned' || entry.recovery?.state === 'orphaned') {
              if (typeof retirement.reconcileOrphan === 'function') await retirement.reconcileOrphan(request);
              continue;
            }
            // A terminal allocation may already have both provider resources
            // absent, or a safely stopped VM. Canonical retirement can close it
            // without a worker dispatch that an absent runner cannot acknowledge.
            // It independently proves completion/ownership/provider absence and
            // keeps deletion gated by its default-false quiescence approval.
            if (typeof retirement.retireAllocation !== 'function') continue;
            const initialRetirement = await retirement.retireAllocation(request);
            if (initialRetirement?.status === 'retired') continue;
            if (initialRetirement?.status !== 'preserved') throw Error('SCHEDULED_RETIREMENT_UNKNOWN');
            request = await unchangedRequest(request); if (!request) continue;
            if (!dispatcher || typeof dispatcher.dispatchIntent !== 'function' ||
                ['requestDrain', 'prepareStop', 'retireAllocation'].some(method => typeof retirement[method] !== 'function')) continue;
            // Canonical controllers prove terminal ownership before intents.
            // Unknown/denied/uncertain acknowledgement never advances to stop.
            // The dispatcher owns consumed attempts and can inspect a pending
            // operation; repeating this pipeline does not grant permission to resend.
            if ((await retirement.requestDrain(request))?.status !== 'intent_recorded') continue;
            request = await unchangedRequest(request); if (!request) continue;
            if ((await dispatcher.dispatchIntent({...request, phase: 'drain'}))?.status !== 'acknowledged') continue;
            request = await unchangedRequest(request); if (!request) continue;
            if ((await retirement.prepareStop(request))?.status !== 'intent_recorded') continue;
            request = await unchangedRequest(request); if (!request) continue;
            if ((await dispatcher.dispatchIntent({...request, phase: 'stop'}))?.status !== 'acknowledged') continue;
            request = await unchangedRequest(request); if (!request) continue;
            await retirement.retireAllocation(request);
          } catch (_) {failures++;}
        }
        return {status: 'completed', processed: keys.length, failures};
      } catch (_) {return preserved();}
    }
  };
}
module.exports = {createScheduledRecovery};
