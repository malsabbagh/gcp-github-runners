'use strict';
const {identity} = require('./job-identity');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// Durable waiting demand lives outside the active VM pool. Rotate a bounded
// query cursor even when capacity remains full; replay through the canonical
// coordinator rather than constructing an independent reservation or build.
function createWaitingRecovery({firestore, provisioning, isEligible, batchSize = 20} = {}) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100)
    throw Error('WAITING_CONFIGURATION_INVALID');
  const configured = firestore && typeof firestore.runTransaction === 'function' &&
    provisioning && typeof provisioning.provision === 'function' && typeof isEligible === 'function';
  async function nextBatch() {
    return firestore.runTransaction(async tx => {
      const cursorRef = firestore.collection('provisioning_cursors').doc('waiting-runtime');
      const cursor = await tx.get(cursorRef);
      const after = cursor.exists ? cursor.data().after : '';
      if (typeof after !== 'string' || after !== '' && !/^[a-f0-9]{64}$/.test(after))
        throw Error('WAITING_CURSOR_UNKNOWN');
      const query = firestore.collection('job_provisioning').where('state', '==', 'waiting').orderBy('__name__').limit(batchSize);
      let page = await tx.get(after ? query.startAfter(after) : query);
      if (page.empty && after) page = await tx.get(query);
      if (!Array.isArray(page.docs) || page.docs.length > batchSize ||
          page.docs.some(doc => typeof doc.id !== 'string' || !/^[a-f0-9]{64}$/.test(doc.id)))
        throw Error('WAITING_PAGE_UNKNOWN');
      const rows = page.docs.map(doc => ({key:doc.id, data:doc.data()}));
      if (new Set(rows.map(row => row.key)).size !== rows.length ||
          rows.some((row, index) => index > 0 && row.key <= rows[index - 1].key))
        throw Error('WAITING_PAGE_UNKNOWN');
      tx.set(cursorRef, {after:rows.length ? rows[rows.length - 1].key : ''});
      return rows;
    });
  }
  return Object.freeze({
    async recoverWaiting() {
      if (!configured) return {status:'disabled',processed:0,failures:0};
      let rows;
      try {rows = await nextBatch();} catch (_) {return {status:'preserved',processed:0,failures:1};}
      let processed = 0, failures = 0;
      for (const {key,data} of rows) {
        try {
          if (!object(data) || data.state !== 'waiting' || data.done !== false || data.executedBy)
            continue;
          if (typeof data.event !== 'string' || data.event.length > 16384) throw Error('WAITING_EVENT_UNKNOWN');
          const event = JSON.parse(data.event);
          if (!object(event) || event.action !== 'queued' || event.verifiedWebhook !== true ||
              identity(event).key !== key || !await isEligible(event)) throw Error('WAITING_EVENT_UNKNOWN');
          // provision() re-reads job state and exact VM capacity transactionally;
          // completion/actual assignment since the page read cannot create a VM.
          const result = await provisioning.provision(event);
          if (!['pending','capacity','submitting','unknown','completed','associated','active','reserved'].includes(result))
            throw Error('WAITING_PROVISIONING_UNKNOWN');
          processed++;
        } catch (_) {failures++;}
      }
      return {status:'completed',processed,failures};
    }
  });
}
module.exports = {createWaitingRecovery};
