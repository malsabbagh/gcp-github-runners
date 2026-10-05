'use strict';
const {isDeepStrictEqual: equal} = require('node:util');
const {createHash, randomUUID} = require('node:crypto');
const {knownReceipt, terminalProof, binding} = require('./allocation-lifecycle');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const preserved = reason => ({status: 'preserved', reason, capacityReleased: false});
// Qualification flags attest an external, authenticated, incarnation-fenced protocol.
// They are not evidence supplied by an endpoint caller. No provider is constructed here.
function createLifecycleDispatcher({firestore, compute, runnerAdapter, workerControl,
  repositoryOwner, repositoryName, projectId, dispatchEnabled = false,
  workerDrainQualified = false, workerStopQualified = false, approvedQuiescence = false,
  clock = Date.now, newDispatchId = randomUUID}) {
  const phases = ['drain', 'stop'];
  const keys = ['key', 'token', 'name', 'zone', 'project', 'instanceId', 'instanceCreationTimestamp', 'claimId', 'phase'];
  const enabled = phase => dispatchEnabled === true && approvedQuiescence === true &&
    workerDrainQualified === true && (phase === 'drain' || workerStopQualified === true);
  function shape(request) {
    return request && Object.keys(request).length === keys.length && keys.every(k => Object.hasOwn(request, k)) &&
      phases.includes(request.phase) && /^[a-f0-9]{64}$/.test(request.key) &&
      typeof request.token === 'string' && /^[a-f0-9-]{36}$/.test(request.token) &&
      typeof request.claimId === 'string' && /^[a-f0-9-]{36}$/.test(request.claimId) &&
      typeof request.name === 'string' && /^[a-z][a-z0-9-]{0,62}$/.test(request.name) &&
      typeof request.zone === 'string' && /^[a-z0-9-]+$/.test(request.zone) && request.project === projectId &&
      typeof request.instanceId === 'string' && /^[1-9][0-9]*$/.test(request.instanceId) &&
      typeof request.instanceCreationTimestamp === 'string' && Number.isFinite(Date.parse(request.instanceCreationTimestamp));
  }
  function decode(pool) {
    const entries = typeof pool?.entries === 'string' ? JSON.parse(pool.entries) : null;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('dispatch_pool_unknown');
    return entries;
  }
  async function transaction(key, fn) {
    return firestore.runTransaction(async tx => {
      const poolRef = firestore.doc('provisioning_pools/global'), jobRef = firestore.doc(`job_provisioning/${key}`);
      const [p, j] = await Promise.all([tx.get(poolRef), tx.get(jobRef)]);
      const pool = p.data(), entries = decode(pool), job = j.data();
      const state = {key, entry: entries[key], job};
      return fn(state, next => {
        entries[key] = {...state.entry, lifecycle: next};
        tx.set(poolRef, {...pool, entries: JSON.stringify(entries)});
        tx.set(jobRef, {lifecycle: JSON.stringify(next)}, {merge: true});
      });
    });
  }
  function validate(state, request) {
    const receipt = knownReceipt(state), e = state.entry;
    if (!receipt || !terminalProof(state, repositoryOwner, repositoryName) || e.project !== projectId) return null;
    const bound = binding(state.key, e, receipt);
    if (['key', 'token', 'name', 'zone', 'project', 'instanceId', 'instanceCreationTimestamp', 'claimId']
      .some(k => bound[k] !== request[k])) return null;
    const lifecycle = e.lifecycle, mirror = typeof state.job.lifecycle === 'string' ? JSON.parse(state.job.lifecycle) : null;
    if (!lifecycle || !equal(lifecycle, mirror)) return null;
    const intent = lifecycle[request.phase], completion = state.job.actualCompletion || state.job.completion;
    if (!intent || intent.version !== 1 || intent.state !== 'requested' ||
      intent.sideEffectsEnabled !== false || !equal(intent.binding, bound) || intent.actualCompletion !== completion) return null;
    if (request.phase === 'stop') {
      const drainContext = validate(state, {...request, phase: 'drain'});
      const drainRecord = lifecycle.drain?.dispatch;
      if (!drainContext || drainRecord?.state !== 'acknowledged' ||
        !recordValid(drainRecord, drainContext, 'drain')) return null;
    }
    // Freeze complete execution evidence across reads/transaction retries, not only the claim.
    const evidence = digest({bound, bootstrap: e.bootstrap, actualJob: e.actualJob || null,
      associationConflict: e.associationConflict || null, event: state.job.event,
      jobBootstrap: state.job.bootstrap, actualJobMirror: state.job.actualJob || null,
      actualCompletion: state.job.actualCompletion || null, completion: state.job.completion || null,
      conflict: state.job.associationConflict || null, intent: {...intent, dispatch: undefined},
      drainDispatch: request.phase === 'stop' ? lifecycle.drain.dispatch : null});
    return {bound, lifecycle, intent, evidence};
  }
  function recordValid(record, context, phase) {
    return record?.version === 1 && typeof record.dispatchId === 'string' &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(record.dispatchId) &&
      typeof record.evidenceSha256 === 'string' && /^[a-f0-9]{64}$/.test(record.evidenceSha256) && record.phase === phase &&
      record.evidenceSha256 === context.evidence && equal(record.binding, context.bound) &&
      Number.isSafeInteger(record.startedAtMs) && record.startedAtMs >= 0 &&
      ['consumed', 'uncertain', 'acknowledged'].includes(record.state) &&
      (record.state !== 'acknowledged' || (Number.isSafeInteger(record.observedAtMs) &&
        record.observedAtMs >= record.startedAtMs && acknowledged(record.acknowledgement, record)));
  }
  const envelope = record => ({version: 1, dispatchId: record.dispatchId, phase: record.phase,
    binding: record.binding, evidenceSha256: record.evidenceSha256});
  function acknowledged(ack, record) {
    return ack && typeof ack === 'object' && !Array.isArray(ack) && Object.keys(ack).length === 8 &&
      typeof ack.dispatchId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(ack.dispatchId) &&
      typeof ack.evidenceSha256 === 'string' && /^[a-f0-9]{64}$/.test(ack.evidenceSha256) &&
      phases.includes(ack.phase) && equal(ack.binding, record.binding) &&
      ack.version === 1 && ack.dispatchId === record.dispatchId && ack.phase === record.phase &&
      ack.evidenceSha256 === record.evidenceSha256 && ack.authenticated === true &&
      ack.incarnationFenced === true && ack.state === (record.phase === 'drain' ? 'drained' : 'stopped');
  }
  async function observations(context) {
    const e = context.bound;
    const [vm] = await compute.get({project: projectId, zone: e.zone, instance: e.name});
    const items = vm?.metadata?.items;
    if (!Array.isArray(items) || items.some(r => typeof r.key !== 'string' || typeof r.value !== 'string') ||
      new Set(items.map(r => r.key)).size !== items.length) return false;
    const metadata = Object.fromEntries(items.map(r => [r.key, r.value]));
    if (String(vm.id) !== e.instanceId || vm.name !== e.name || vm.creationTimestamp !== e.instanceCreationTimestamp ||
      vm.zone !== `https://www.googleapis.com/compute/v1/projects/${projectId}/zones/${e.zone}` ||
      vm.selfLink !== `https://www.googleapis.com/compute/v1/projects/${projectId}/zones/${e.zone}/instances/${e.name}` ||
      !['RUNNING', 'TERMINATED'].includes(vm.status) ||
      vm.labels?.purpose !== 'github-runner' || metadata['allocation-key'] !== e.key ||
      metadata['reservation-token'] !== e.token) return false;
    let total; const rows = [];
    for (let page = 1; page <= 100; page++) {
      const body = await runnerAdapter.listRunnerPage({page, perPage: 100});
      if (!Number.isSafeInteger(body?.total_count) || body.total_count < 0 || !Array.isArray(body.runners) ||
        body.runners.length > 100 || (total !== undefined && total !== body.total_count)) return false;
      total = body.total_count; rows.push(...body.runners);
      if (body.runners.length < 100) break;
      if (page === 100) return false;
    }
    if (rows.length !== total || new Set(rows.map(r => r.id)).size !== total ||
      new Set(rows.map(r => r.name)).size !== total || rows.some(r => !Number.isSafeInteger(r.id) ||
        r.id <= 0 || typeof r.name !== 'string' || typeof r.busy !== 'boolean')) return false;
    const exact = rows.find(r => r.id === e.runnerId);
    const labels = exact?.labels?.map(x => x?.name);
    if (!exact || exact.name !== e.runnerName || exact.busy !== false || !Array.isArray(labels) ||
      labels.some(x => typeof x !== 'string' || !x) || new Set(labels).size !== labels.length ||
      labels.length !== e.labels.length || e.labels.some(x => !labels.includes(x)) ||
      rows.some(r => r.id !== e.runnerId && (r.name === e.name || r.name.startsWith(e.name + '-')))) return false;
    const inspect = await runnerAdapter.inspectOwnedRunner({runnerId: e.runnerId, expectedName: e.runnerName, expectedLabels: e.labels});
    return inspect?.status === 'present' && inspect.busy === false;
  }
  async function mark(request, context, record, state, ack) {
    const observedAtMs = clock();
    if (!Number.isSafeInteger(observedAtMs) || observedAtMs < record.startedAtMs) return false;
    return transaction(request.key, (current, write) => {
      const fresh = validate(current, request), existing = fresh?.intent.dispatch;
      if (!fresh || fresh.evidence !== context.evidence || !equal(existing, record)) return false;
      const nextRecord = {...record, state, observedAtMs,
        ...(state === 'acknowledged' ? {acknowledgement: ack} : {})};
      const next = {...fresh.lifecycle, [request.phase]: {...fresh.intent, dispatch: nextRecord}};
      write(next); return true;
    });
  }
  async function run(request, inspectOnly) {
    if (!shape(request)) return preserved('invalid_dispatch_request');
    if (!enabled(request.phase)) return preserved('dispatch_not_qualified');
    let context, record;
    try {
      context = await transaction(request.key, state => validate(state, request));
      if (!context) return preserved('lifecycle_ownership_or_terminal_proof_unknown');
      record = context.intent.dispatch;
      if (record && !recordValid(record, context, request.phase)) return preserved('dispatch_binding_unknown');
      if (record?.state === 'acknowledged') return {status: 'acknowledged', phase: request.phase,
        dispatchId: record.dispatchId, capacityReleased: false};
      if (!record && inspectOnly) return preserved('dispatch_not_started');
      if (record) {
        // An ambiguous attempt is recovered only by readback of THIS operation; never resend.
        const fresh = await transaction(request.key, state => validate(state, request));
        if (!fresh || fresh.evidence !== context.evidence || !equal(fresh.intent.dispatch, record))
          return preserved('dispatch_evidence_changed');
        const ack = await workerControl.inspectOperation(envelope(record));
        if (!acknowledged(ack, record)) return preserved('dispatch_outcome_uncertain');
        if (!(await mark(request, context, record, 'acknowledged', ack))) return preserved('dispatch_evidence_changed');
      } else {
        if (!(await observations(context))) return preserved('provider_ownership_or_busy_unknown');
        const dispatchId = newDispatchId(), startedAtMs = clock();
        if (typeof dispatchId !== 'string' || !/^[a-f0-9-]{36}$/.test(dispatchId) ||
          !Number.isSafeInteger(startedAtMs) || startedAtMs < 0)
          return preserved('dispatch_identifier_unknown');
        record = {version: 1, dispatchId, phase: request.phase, binding: context.bound,
          evidenceSha256: context.evidence, state: 'consumed', startedAtMs};
        const reserved = await transaction(request.key, (state, write) => {
          const fresh = validate(state, request);
          if (!fresh || fresh.evidence !== context.evidence || fresh.intent.dispatch) return false;
          write({...fresh.lifecycle, [request.phase]: {...fresh.intent, dispatch: record}}); return true;
        });
        if (!reserved) return preserved('dispatch_evidence_changed');
        // Provider observations occurred before the final evidence CAS; the operation is now single-use.
        const method = request.phase === 'drain' ? 'requestDrain' : 'requestStop';
        const ack = await workerControl[method](envelope(record));
        if (!acknowledged(ack, record)) {
          await mark(request, context, record, 'uncertain'); return preserved('dispatch_outcome_uncertain');
        }
        if (!(await mark(request, context, record, 'acknowledged', ack))) return preserved('dispatch_evidence_changed');
      }
      return {status: 'acknowledged', phase: request.phase, dispatchId: record.dispatchId, capacityReleased: false};
    } catch (_) {
      if (record && context) {try {await mark(request, context, record, 'uncertain');} catch (_) {}}
      return preserved('dispatch_outcome_uncertain');
    }
  }
  return {dispatchIntent: request => run(request, false), inspectDispatch: request => run(request, true)};
}
module.exports = {createLifecycleDispatcher};
