'use strict';
const safe = reason => new Error(reason);
const {isDeepStrictEqual} = require('node:util');
const {knownReceipt, terminalProof, binding} = require('./allocation-lifecycle');
// Imported by the controller identity's authenticated retirement endpoint.
// Cleanup/worker identities cannot supply their own provider or state objects.
// All durable writes use the existing allocation pool and job record.
function createRetirementController({firestore, compute, runnerAdapter, projectId, repositoryOwner, repositoryName,
                                     poolDocument = 'provisioning_pools/global', approvedQuiescence = false,workerStopQualified = false}) {
  if (!projectId || !repositoryOwner || !repositoryName) throw safe('invalid_retirement_configuration');
  const poolRef = firestore.doc(poolDocument);
  const jobRef = key => firestore.doc(`job_provisioning/${key}`);
  const result = reason => ({status: 'preserved', reason});
  function entriesFrom(pool) {
    if (!pool || typeof pool.entries !== 'string') throw safe('cleanup_pool_codec_unknown');
    const entries = JSON.parse(pool.entries);
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw safe('cleanup_pool_codec_unknown');
    return entries;
  }
  function same(a, b) {
    return a && b && a.token === b.token && a.name === b.name && a.zone === b.zone &&
      a.project === b.project && a.instanceId === b.instanceId &&
      a.instanceCreationTimestamp === b.instanceCreationTimestamp &&
      (b.claimId === undefined || a.bootstrap?.claimId === b.claimId) &&
      (!b.runnerIdentity || (JSON.stringify(a.runnerIdentity) === JSON.stringify(b.runnerIdentity) &&
        isDeepStrictEqual(a.bootstrap, b.bootstrap) && isDeepStrictEqual(a.actualJob, b.actualJob) &&
        isDeepStrictEqual(a.associationConflict, b.associationConflict)));
  }
  function requestShape(r) {
    return r && /^[a-f0-9]{64}$/.test(r.key || '') && /^[A-Za-z0-9_-]{16,128}$/.test(r.token || '') &&
      /^[a-z][a-z0-9-]{0,62}$/.test(r.name || '') && /^[a-z0-9-]+$/.test(r.zone || '') &&
      /^[0-9]+$/.test(r.instanceId || '') && r.project === projectId;
  }
  async function readState(key) {
    return firestore.runTransaction(async tx => {
      const [pool, job] = await Promise.all([tx.get(poolRef), tx.get(jobRef(key))]);
      return {key, entry: entriesFrom(pool.data())[key], job: job.data()};
    });
  }
  async function inspectVm(entry) {
    try {
      const [vm] = await compute.get({project: projectId, zone: entry.zone, instance: entry.name});
      return {absent: false, vm};
    } catch (error) {
      // Compute InstancesClient gRPC NOT_FOUND is the only absence classification.
      if (error && error.code === 5) return {absent: true};
      throw safe('cleanup_compute_unknown');
    }
  }
  function ownedVm(vm, entry, key, statuses = ['TERMINATED']) {
    const rows = vm.metadata?.items;
    if (!Array.isArray(rows) || rows.some(row => typeof row.key !== 'string' || typeof row.value !== 'string') ||
        new Set(rows.map(row => row.key)).size !== rows.length) return false;
    const metadata = Object.fromEntries(rows.map(row => [row.key, row.value]));
    return String(vm.id) === entry.instanceId && vm.name === entry.name &&
      vm.creationTimestamp === entry.instanceCreationTimestamp && statuses.includes(vm.status) &&
      vm.zone?.split('/').pop() === entry.zone && vm.labels?.purpose === 'github-runner' &&
      metadata['allocation-key'] === key && metadata['reservation-token'] === entry.token;
  }
  function completed(state) {
    return terminalProof(state, repositoryOwner, repositoryName);
  }
  async function inventory() {
    let total;
    const rows = [];
    for (let page = 1; page <= 100; page++) {
      const body = await runnerAdapter.listRunnerPage({page, perPage: 100});
      if (!body || !Number.isSafeInteger(body.total_count) || body.total_count < 0 ||
          !Array.isArray(body.runners) || body.runners.length > 100 ||
          body.runners.some(r => !Number.isSafeInteger(r.id) || r.id <= 0 ||
            typeof r.name !== 'string' || typeof r.busy !== 'boolean')) throw safe('cleanup_inventory_unknown');
      if (total !== undefined && total !== body.total_count) throw safe('cleanup_inventory_changed');
      total = body.total_count;
      rows.push(...body.runners);
      if (body.runners.length < 100) {
        if (rows.length !== total || new Set(rows.map(r => r.id)).size !== total ||
            new Set(rows.map(r => r.name)).size !== total) throw safe('cleanup_inventory_incomplete');
        return rows;
      }
    }
    throw safe('cleanup_inventory_limit');
  }
  async function fence(key, expected, update) {
    return firestore.runTransaction(async tx => {
      const [pool, job] = await Promise.all([tx.get(poolRef), tx.get(jobRef(key))]);
      const data = pool.data(); const entries = entriesFrom(data); const entry = entries[key];
      if (!same(entry, expected) || !completed({key, entry, job: job.data()})) return false;
      const attempt = Number.isSafeInteger(entry.cleanup?.attempt) ? entry.cleanup.attempt + 1 : 1;
      const proof = {...update, attempt};
      tx.set(poolRef, {...data, entries: JSON.stringify({...entries, [key]: {...entry, state: 'retiring', cleanup: proof}})});
      tx.set(jobRef(key), {cleanup: JSON.stringify(proof)}, {merge: true});
      return true;
    });
  }
  function registrationSafe(rows, entry, receipt) {
    return !rows.some(row =>
      ((row.id === receipt.runnerId || row.name === entry.name || row.name.startsWith(entry.name + '-')) &&
       (row.id !== receipt.runnerId || row.name !== receipt.runnerName || row.busy)));
  }
  async function lifecycleIntent(request, phase) {
    if (!requestShape(request)) return result('invalid_request');
    try {
      const state = await readState(request.key), entry = state.entry;
      const receipt = knownReceipt(state);
      if (!same(entry, request) || !receipt || !completed(state)) return result('missing_actual_completion_proof');
      const inspection = await inspectVm(entry);
      if (inspection.absent) return result('instance_absent_use_orphan_reconciliation');
      if (!ownedVm(inspection.vm, entry, request.key, ['RUNNING', 'TERMINATED'])) return result('instance_changed_or_starting');
      const rows = await inventory();
      const exact = rows.find(row => row.id === receipt.runnerId);
      if (!registrationSafe(rows, entry, receipt) || (exact && !labelsMatch(exact, receipt)))
        return result('registration_ambiguous_or_busy');
      return firestore.runTransaction(async tx => {
        const [pool, job] = await Promise.all([tx.get(poolRef), tx.get(jobRef(request.key))]);
        const data = pool.data(), entries = entriesFrom(data), current = entries[request.key], currentJob = job.data();
        const currentState = {key: request.key, entry: current, job: currentJob};
        if (!same(current, entry) || !completed(currentState)) return result('allocation_or_completion_changed');
        const currentReceipt = knownReceipt(currentState), bound = binding(request.key, current, currentReceipt);
        const lifecycle = current.lifecycle || {};
        const mirror = typeof currentJob.lifecycle === 'string' ? JSON.parse(currentJob.lifecycle) : {};
        if (typeof lifecycle !== 'object' || Array.isArray(lifecycle) ||
            !mirror || typeof mirror !== 'object' || Array.isArray(mirror)) return result('lifecycle_state_unknown');
        if (!isDeepStrictEqual(lifecycle, mirror)) return result('lifecycle_mirror_changed');
        if (phase === 'stop' && (!lifecycle.drain || !isDeepStrictEqual(lifecycle.drain.binding, bound)))
          return result('matching_drain_intent_missing');
        if (lifecycle[phase]) {
          return isDeepStrictEqual(lifecycle[phase].binding, bound) ?
            {status: 'intent_recorded', phase, sideEffectsEnabled: false} : result('lifecycle_binding_changed');
        }
        const next = {...lifecycle, [phase]: {version: 1, state: 'requested', binding: bound,
          actualCompletion: currentJob.actualCompletion || currentJob.completion,
          observedVmStatus: inspection.vm.status, observedAtMs: Date.now(), sideEffectsEnabled: false}};
        entries[request.key] = {...current, state: 'retiring', lifecycle: next};
        tx.set(poolRef, {...data, entries: JSON.stringify(entries)});
        tx.set(jobRef(request.key), {lifecycle: JSON.stringify(next)}, {merge: true});
        return {status: 'intent_recorded', phase, sideEffectsEnabled: false};
      });
    } catch (_) {return result('lifecycle_proof_unknown');}
  }
  const requestDrain = request => lifecycleIntent(request, 'drain');
  const prepareStop = request => lifecycleIntent(request, 'stop');
  async function stopCompletedWorker(state,request,inspection) {
    const entry=state.entry,receipt=knownReceipt(state);
    if (approvedQuiescence!==true || workerStopQualified!==true || !receipt || !completed(state)) return null;
    const bound=binding(request.key,entry,receipt);
    function stopProof(current) {
      if (!same(current.entry,entry) || !completed(current)) return null;
      const life=current.entry.lifecycle,mirror=typeof current.job.lifecycle==='string'?JSON.parse(current.job.lifecycle):null;
      const drain=life?.drain?.dispatch,stop=life?.stop?.dispatch;
      if (!isDeepStrictEqual(life,mirror) || !drain || !stop ||
          life.drain.version!==1 || life.stop.version!==1 || life.drain.state!=='requested' || life.stop.state!=='requested' ||
          !isDeepStrictEqual(life.drain.binding,bound) || !isDeepStrictEqual(life.stop.binding,bound) ||
          life.drain.actualCompletion!==(current.job.actualCompletion||current.job.completion) ||
          life.stop.actualCompletion!==(current.job.actualCompletion||current.job.completion) ||
          drain.state!=='acknowledged' || stop.state!=='acknowledged' ||
          !isDeepStrictEqual(drain.binding,bound) || !isDeepStrictEqual(stop.binding,bound)) return null;
      for (const [phase,record] of [['drain',drain],['stop',stop]]) {
        const ack=record.acknowledgement;
        if (record.version!==1 || !/^[a-f0-9-]{36}$/.test(record.dispatchId) || !/^[a-f0-9]{64}$/.test(record.evidenceSha256)) return null;
        if (!ack || Object.keys(ack).length!==8 || ack.version!==1 || ack.phase!==phase || ack.dispatchId!==record.dispatchId ||
            ack.evidenceSha256!==record.evidenceSha256 || !isDeepStrictEqual(ack.binding,bound) ||
            ack.authenticated!==true || ack.incarnationFenced!==true || ack.state!==(phase==='drain'?'drained':'stopped')) return null;
      }
      return {version:1,binding:bound,dispatchId:stop.dispatchId,evidenceSha256:stop.evidenceSha256};
    }
    const proof=stopProof(state);
    if (!proof || !ownedVm(inspection.vm,entry,request.key,['RUNNING','STOPPING','TERMINATED'])) return null;
    const rows=await inventory(),exact=rows.find(r=>r.id===receipt.runnerId);
    if (!registrationSafe(rows,entry,receipt) || exact && !labelsMatch(exact,receipt)) return null;
    const lookup=await runnerAdapter.inspectOwnedRunner({runnerId:receipt.runnerId,expectedName:receipt.runnerName,expectedLabels:receipt.labels});
    if (exact ? lookup?.status!=='present' || lookup.busy!==false : lookup?.status!=='absent') return null;
    let shouldStop=false;
    const accepted=await firestore.runTransaction(async tx=> {
      shouldStop=false;
      const [pool,job]=await Promise.all([tx.get(poolRef),tx.get(jobRef(request.key))]);
      const data=pool.data(),entries=entriesFrom(data),current={key:request.key,entry:entries[request.key],job:job.data()};
      if (!isDeepStrictEqual(stopProof(current),proof)) return false;
      const old=current.entry.providerStop,mirror=typeof current.job.providerStop==='string'?JSON.parse(current.job.providerStop):null;
      if (old!==undefined) return isDeepStrictEqual(old,mirror) && Object.keys(old).length===6 && Number.isSafeInteger(old.startedAtMs) && old.version===1 && old.state==='consumed' &&
        isDeepStrictEqual(old.binding,proof.binding) && old.dispatchId===proof.dispatchId && old.evidenceSha256===proof.evidenceSha256;
      if (inspection.vm.status!=='RUNNING') return false;
      const record={...proof,state:'consumed',startedAtMs:Date.now()};
      entries[request.key]={...current.entry,providerStop:record};
      tx.set(poolRef,{...data,entries:JSON.stringify(entries)});tx.set(jobRef(request.key),{providerStop:JSON.stringify(record)},{merge:true});
      shouldStop=true;return true;
    });
    if (!accepted) return null;
    // The durable consumption precedes the named provider effect. A timeout or
    // lost response never permits a second stop. Subsequent attempts inspect
    // this exact incarnation only. Named mutation still requires actor quiescence.
    if (shouldStop) {
      const fresh=await inspectVm(entry),current=await readState(request.key);
      if (fresh.absent || !ownedVm(fresh.vm,entry,request.key,['RUNNING']) || !isDeepStrictEqual(stopProof(current),proof)) return null;
      try {await compute.stop({project:projectId,zone:entry.zone,instance:entry.name});}catch(_){return null;}
    }
    const after=await inspectVm(entry);
    return after.absent || ownedVm(after.vm,entry,request.key) ? after : null;
  }
  async function retireAllocation(request) {
    if (!requestShape(request)) return result('invalid_request');
    try {
      let state = await readState(request.key); const entry = state.entry;
      if (!same(entry, request) || !completed(state)) return result('missing_terminal_ownership_proof');
      let initial = await inspectVm(entry);
      if (!initial.absent && ['RUNNING','STOPPING'].includes(initial.vm?.status)) {
        const stopped=await stopCompletedWorker(state,request,initial);
        if (!stopped) return result('provider_stop_pending_or_unqualified');
        initial=stopped;
      }
      if (!initial.absent && !ownedVm(initial.vm, entry, request.key)) return result('instance_running_or_changed');
      const rows = await inventory();
      const identity = entry.runnerIdentity;
      // Preserve every unknown near-prefix registration, including busy rows.
      if (rows.some(r => (r.name === entry.name || r.name.startsWith(entry.name + '-')) &&
          (r.id !== identity.id || r.name !== identity.name || r.busy))) return result('registration_ambiguous_or_busy');
      const exact = rows.find(r => r.id === identity.id);
      if (exact && (exact.name !== identity.name || exact.busy)) return result('runner_identity_changed_or_busy');
      const evidence = {state: 'retiring', runnerAbsent: false, instanceAbsent: initial.absent,
                        lastAttemptAtMs: Date.now(), reason: 'terminal_ownership_verified'};
      if (!await fence(request.key, entry, evidence)) return result('allocation_changed');
      const input = {runnerId: identity.id, expectedName: identity.name, expectedLabels: identity.labels};
      // An unapproved controller may confirm existing absence read-only, but
      // must never invoke an adapter method capable of deleting a registration.
      const deregistration = approvedQuiescence === true ? await runnerAdapter.deregisterOwnedRunner(input) :
        await runnerAdapter.inspectOwnedRunner(input);
      if (approvedQuiescence !== true && deregistration?.status !== 'absent')
        return result('runner_deregistration_quiescence_unapproved');
      if (deregistration?.status !== 'absent') return result('runner_absence_unconfirmed');
      // Recheck the COMPLETE paginated inventory after deregistration, not a prefix query.
      const after = await inventory();
      if (after.some(r => r.id === identity.id || r.name === entry.name || r.name.startsWith(entry.name + '-')))
        return result('registration_remains');
      state = await readState(request.key);
      if (!same(state.entry, entry) || !completed(state)) return result('allocation_changed');
      const current = await inspectVm(entry);
      if (!current.absent) {
        if (!ownedVm(current.vm, entry, request.key)) return result('instance_running_or_changed');
        // Named Compute deletion lacks incarnation CAS. This candidate defaults
        // to no deletion; live quiescence/IAM scope must be explicitly approved
        // and enforced externally before the controller may enable this flag.
        if (approvedQuiescence !== true) return result('instance_delete_quiescence_unapproved');
        await compute.delete({project: projectId, zone: entry.zone, instance: entry.name});
      }
      const final = await inspectVm(entry);
      if (!final.absent) return result('instance_absence_unconfirmed');
      // A final fresh GitHub inventory closes absence before release.
      if ((await inventory()).some(r => r.id === identity.id || r.name === entry.name || r.name.startsWith(entry.name + '-')))
        return result('registration_remains');
      return firestore.runTransaction(async tx => {
        const [pool, job] = await Promise.all([tx.get(poolRef), tx.get(jobRef(request.key))]);
        const data = pool.data(); const entries = entriesFrom(data); const currentEntry = entries[request.key];
        if (!same(currentEntry, entry) || !completed({key: request.key, entry: currentEntry, job: job.data()})) return result('allocation_changed');
        const terminalJob = {...job.data()};
        const history = terminalJob.bootstrapHistory ? JSON.parse(terminalJob.bootstrapHistory) : [];
        if (!Array.isArray(history) || history.length >= 100) return result('bootstrap_archive_unavailable');
        history.push({instanceId: entry.instanceId, instanceCreationTimestamp: entry.instanceCreationTimestamp,
          reservationToken: entry.token, bootstrap: JSON.parse(terminalJob.bootstrap), archivedAtMs: Date.now()});
        terminalJob.bootstrapHistory = JSON.stringify(history);
        delete terminalJob.bootstrap;
        terminalJob.cleanup = JSON.stringify({state: 'retired', runnerAbsent: true, instanceAbsent: true,
          instanceId: entry.instanceId, claimId: entry.bootstrap.claimId, allocation: currentEntry,
          actualCompletion: terminalJob.actualCompletion || null, retiredAtMs: Date.now()});
        // Preserve proof in the retirement receipt. A later reservation must not
        // inherit this old incarnation's association. Never synthesize job.done.
        delete terminalJob.actualJob;
        delete terminalJob.actualCompletion;
        delete terminalJob.lifecycle;delete terminalJob.workerControl;delete terminalJob.providerStop;
        terminalJob.state = terminalJob.done ? 'completed' : terminalJob.executedBy ? 'associated' : 'waiting';
        delete entries[request.key];
        tx.set(poolRef, {...data, entries: JSON.stringify(entries)});
        tx.set(jobRef(request.key), terminalJob);
        return {status: 'retired'};
      });
    } catch (_) {
      // Errors, busy state and partial deletion never release capacity by age.
      return result('cleanup_verification_failed');
    }
  }
  function labelsMatch(row, receipt) {
    return Array.isArray(row.labels) && row.labels.every(x => x && typeof x.name === 'string') &&
      new Set(row.labels.map(x => x.name)).size === row.labels.length &&
      isDeepStrictEqual(row.labels.map(x => x.name).sort(), [...receipt.labels].sort());
  }
  async function readOrphanState(request) {
    return firestore.runTransaction(async tx => {
      const [pool, jobSnap] = await Promise.all([tx.get(poolRef), tx.get(jobRef(request.key))]);
      const entries = entriesFrom(pool.data()), job = jobSnap.data(), entry = entries[request.key];
      if (entry) {
        if (!same(entry, request)) return null;
        return {key: request.key, entry, job, archived: false};
      }
      const pending = typeof job?.pendingCleanup === 'string' ? JSON.parse(job.pendingCleanup) : [];
      const history = typeof job?.bootstrapHistory === 'string' ? JSON.parse(job.bootstrapHistory) : [];
      if (!Array.isArray(pending) || pending.length > 100 || !Array.isArray(history) || history.length > 100) return null;
      const matches = pending.map((value, index) => ({value, index})).filter(({value}) =>
        same(value?.allocation, request) && value.allocation.bootstrap?.claimId === request.claimId);
      if (matches.length !== 1) return null;
      const {value, index} = matches[0], old = value.allocation;
      const receipts = history.filter(item => item.instanceId === old.instanceId &&
        item.instanceCreationTimestamp === old.instanceCreationTimestamp && item.reservationToken === old.token &&
        isDeepStrictEqual(item.bootstrap, old.bootstrap));
      if (receipts.length !== 1) return null;
      return {key: request.key, entry: old, job: {...job, bootstrap: JSON.stringify(receipts[0].bootstrap)},
        archived: true, archiveIndex: index, archiveRecord: value};
    });
  }
  async function recordOrphan(request, expected, phase, reason, startAttempt = false) {
    return firestore.runTransaction(async tx => {
      const [pool, jobSnap] = await Promise.all([tx.get(poolRef), tx.get(jobRef(request.key))]);
      const data = pool.data(), entries = entriesFrom(data), job = jobSnap.data();
      const receipt = knownReceipt(expected, {allowClaimed: true});
      if (!receipt) return false;
      if (['event', 'actualJob', 'actualCompletion', 'associationConflict'].some(field =>
          job?.[field] !== expected.job?.[field])) return false;
      const prior = expected.archived ? expected.archiveRecord.cleanup : entries[request.key]?.cleanup;
      if (prior?.attempt !== undefined && (!Number.isSafeInteger(prior.attempt) || prior.attempt < 0 || prior.attempt >= 10000)) return false;
      const attempt = Number.isSafeInteger(prior?.attempt) && prior.attempt >= 0 ? prior.attempt + (startAttempt ? 1 : 0) : 1;
      const proof = {version: 1, state: phase, mode: 'orphan', reason, attempt,
        binding: binding(request.key, expected.entry, receipt), observedAtMs: Date.now(),
        runnerAbsent: phase === 'reconciled', instanceAbsent: true, accountingGap: expected.archived};
      if (expected.archived) {
        if (entries[request.key]) return false;
        const pending = typeof job?.pendingCleanup === 'string' ? JSON.parse(job.pendingCleanup) : [];
        if (!Array.isArray(pending) || !isDeepStrictEqual(pending[expected.archiveIndex], expected.archiveRecord)) return false;
        const history = typeof job.bootstrapHistory === 'string' ? JSON.parse(job.bootstrapHistory) : [];
        if (!Array.isArray(history) || history.filter(item => item.instanceId === expected.entry.instanceId &&
            item.instanceCreationTimestamp === expected.entry.instanceCreationTimestamp && item.reservationToken === expected.entry.token &&
            isDeepStrictEqual(item.bootstrap, expected.entry.bootstrap)).length !== 1 || job.associationConflict) return false;
        pending[expected.archiveIndex] = {...pending[expected.archiveIndex], cleanup: proof};
        tx.set(jobRef(request.key), {pendingCleanup: JSON.stringify(pending), cleanup: JSON.stringify(proof)}, {merge: true});
      } else {
        const entry = entries[request.key];
        const current = {key: request.key, entry, job};
        if (!same(entry, expected.entry) || !isDeepStrictEqual(knownReceipt(current, {allowClaimed: true}), receipt)) return false;
        if (phase === 'reconciled' && (entry.actualJob || job.actualJob || job.actualCompletion) && !completed(current)) return false;
        if (phase === 'reconciled') {
          const bootstrapHistory = job.bootstrapHistory ? JSON.parse(job.bootstrapHistory) : [];
          if (!Array.isArray(bootstrapHistory) || bootstrapHistory.length >= 100) return false;
          bootstrapHistory.push({instanceId: entry.instanceId, instanceCreationTimestamp: entry.instanceCreationTimestamp,
            reservationToken: entry.token, bootstrap: entry.bootstrap, archivedAtMs: Date.now()});
          const terminalJob = {...job, bootstrapHistory: JSON.stringify(bootstrapHistory),
            cleanup: JSON.stringify({...proof, allocation: entry, actualCompletion: job.actualCompletion || null})};
          delete terminalJob.bootstrap; delete terminalJob.actualJob; delete terminalJob.actualCompletion;
          delete terminalJob.lifecycle;delete terminalJob.workerControl;delete terminalJob.providerStop;
          terminalJob.state = terminalJob.done ? 'completed' : terminalJob.executedBy ? 'associated' : 'waiting';
          delete entries[request.key];
          tx.set(poolRef, {...data, entries: JSON.stringify(entries)});
          tx.set(jobRef(request.key), terminalJob);
        } else {
          entries[request.key] = {...entry, state: 'orphaned', cleanup: proof};
          tx.set(poolRef, {...data, entries: JSON.stringify(entries)});
          tx.set(jobRef(request.key), {cleanup: JSON.stringify(proof)}, {merge: true});
        }
      }
      return true;
    });
  }
  async function reconcileOrphan(request) {
    if (!requestShape(request) || typeof request.claimId !== 'string') return result('invalid_orphan_request');
    let state;
    let fenced = false;
    async function preserve(reason) {
      if (fenced) {
        try {
          const fresh = await readOrphanState(request);
          if (fresh && same(fresh.entry, state.entry)) await recordOrphan(request, fresh, 'pending', reason);
        } catch (_) { /* Pending ownership proof remains charged. */ }
      }
      return result(reason);
    }
    try {
      state = await readOrphanState(request);
      const receipt = state && knownReceipt(state, {allowClaimed: true});
      if (!receipt || receipt.claimId !== request.claimId) return result('known_orphan_receipt_missing');
      const inspection = await inspectVm(state.entry);
      if (!inspection.absent) return result('orphan_instance_present_or_replaced');
      if (!await recordOrphan(request, state, 'pending', 'owned_instance_absence_verified', true)) return result('orphan_ownership_changed');
      state = await readOrphanState(request);
      if (!state || !isDeepStrictEqual(knownReceipt(state, {allowClaimed: true}), receipt)) return result('orphan_ownership_changed');
      fenced = true;
      // VM loss is not signed actual-job completion. An observed running or
      // inconsistent execution remains charged; explicit recovery of the
      // corresponding workflow job is a separate unimplemented boundary.
      if ((state.entry.actualJob || state.job.actualJob || state.job.actualCompletion) && !completed(state))
        return preserve('orphan_actual_execution_unresolved');
      const rows = await inventory();
      if (!registrationSafe(rows, state.entry, receipt)) return preserve('orphan_registration_unknown_or_busy');
      const exact = rows.find(row => row.id === receipt.runnerId);
      if (exact && !labelsMatch(exact, receipt)) return preserve('orphan_registration_labels_changed');
      const inspectionById = await runnerAdapter.inspectOwnedRunner({runnerId: receipt.runnerId,
        expectedName: receipt.runnerName, expectedLabels: receipt.labels});
      if (inspectionById?.status === 'present') {
        if (inspectionById.busy !== false || approvedQuiescence !== true) return preserve('orphan_deregistration_unapproved_or_busy');
        // Revalidate receipt and authoritative VM absence immediately before the
        // exact App-side effect. Name guesses or provider errors never qualify.
        const fresh = await readOrphanState(request);
        if (!fresh || !isDeepStrictEqual(knownReceipt(fresh, {allowClaimed: true}), receipt) ||
            !(await inspectVm(fresh.entry)).absent)
          return preserve('orphan_predelete_proof_changed');
        const currentRows = await inventory(), currentRunner = currentRows.find(row => row.id === receipt.runnerId);
        if (!registrationSafe(currentRows, fresh.entry, receipt) || (currentRunner && !labelsMatch(currentRunner, receipt)))
          return preserve('orphan_predelete_proof_changed');
        // Provider observations above await external reads. Re-read the entire
        // owned execution proof AFTER them, immediately before the App method.
        const finalState = await readOrphanState(request);
        if (!finalState || !same(finalState.entry, state.entry) ||
            !isDeepStrictEqual(finalState.entry.actualJob, state.entry.actualJob) ||
            !isDeepStrictEqual(finalState.entry.associationConflict, state.entry.associationConflict) ||
            !isDeepStrictEqual(knownReceipt(finalState, {allowClaimed: true}), receipt) ||
            ['event', 'actualJob', 'actualCompletion', 'associationConflict', 'completion'].some(field =>
              finalState.job[field] !== state.job[field]) ||
            ((finalState.entry.actualJob || finalState.job.actualJob || finalState.job.actualCompletion) && !completed(finalState)))
          return preserve('orphan_predelete_proof_changed');
        const removal = await runnerAdapter.deregisterOwnedRunner({runnerId: receipt.runnerId,
          expectedName: receipt.runnerName, expectedLabels: receipt.labels});
        if (removal?.status !== 'absent') return preserve('orphan_runner_absence_unconfirmed');
      } else if (inspectionById?.status !== 'absent') return preserve('orphan_runner_provider_unknown');
      const exactAfter = await runnerAdapter.inspectOwnedRunner({runnerId: receipt.runnerId,
        expectedName: receipt.runnerName, expectedLabels: receipt.labels});
      const after = await inventory();
      if (exactAfter?.status !== 'absent' || after.some(row => row.id === receipt.runnerId ||
          row.name === state.entry.name || row.name.startsWith(state.entry.name + '-')) ||
          !(await inspectVm(state.entry)).absent) return preserve('orphan_absence_unconfirmed');
      if (!await recordOrphan(request, state, 'reconciled', 'both_provider_absences_verified')) return result('orphan_ownership_changed');
      return state.archived ? {status: 'orphan_reconciled', accountingGap: true, capacityAlreadyReleased: true} :
        {status: 'orphan_reconciled', accountingGap: false};
    } catch (_) {
      // Durable pending proof remains charged. Never reset a claim or remint.
      return preserve('orphan_verification_unknown');
    }
  }
  return {retireAllocation, inventory, requestDrain, prepareStop, reconcileOrphan};
}
module.exports = {createRetirementController};
