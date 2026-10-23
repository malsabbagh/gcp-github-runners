const crypto = require("node:crypto");
const { identity } = require("./job-identity");

// Only a local caller that has not invoked the build API may construct this.
// Service/RPC errors after submission retain their existing ambiguity rules.
class BuildNotSubmitted extends Error {
  constructor(cause) {
    super('Build submission was not attempted', {cause});
    this.code = cause.code;
  }
}

function readPool(doc) {
  if (!doc.exists) return {};
  const entries = JSON.parse(doc.data().entries);
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw new Error("Invalid provisioning pool");
  return entries;
}
// Independently authored receipt archive; only call after authoritative VM absence.
function archiveBootstrap(job, entry) {
  const pending = job.pendingCleanup ? JSON.parse(job.pendingCleanup) : [];
  if (!Array.isArray(pending) || pending.length >= 100) throw new Error("Allocation audit archive unavailable");
  // Full old ownership/incarnation/build/bootstrap/runner record survives slot release.
  // This is evidence for a future orphan-retirement path, not proof it ran.
  pending.push({allocation: JSON.parse(JSON.stringify(entry)), archivedAtMs: Date.now()});
  job.pendingCleanup = JSON.stringify(pending);
  if (!job.bootstrap) return;
  const bootstrap = JSON.parse(job.bootstrap);
  const history = job.bootstrapHistory ? JSON.parse(job.bootstrapHistory) : [];
  if (!Array.isArray(history) || history.length >= 100 || !bootstrap || typeof bootstrap !== "object") throw new Error("Bootstrap audit archive unavailable");
  history.push({instanceId: entry.instanceId || null, instanceCreationTimestamp: entry.instanceCreationTimestamp || null,
    reservationToken: entry.token, bootstrap, archivedAtMs: Date.now()});
  job.bootstrapHistory = JSON.stringify(history);
  delete job.bootstrap;
}
function coordinator({ firestore, cloudBuild, compute, project, zone, limit, createBuild,
  recovery, workerServiceAccountEmail, workerServiceAccountUniqueId,
  brokerUrl, bootstrapTTLms = 600000, clock = Date.now, recoveryBatchSize = 20 }) {
  const pool = firestore.collection("provisioning_pools").doc("global");
  const jobRef = key => firestore.collection("job_provisioning").doc(key);
  const cursor = firestore.collection('provisioning_cursors').doc('incarnation');
  async function inventory() {
    const names = new Set();
    for await (const [scopeName, scope] of compute.aggregatedListAsync({ project, filter: "labels.purpose = github-runner" })) {
      if ((scope.instances || []).length && !scopeName.startsWith("zones/")) throw new Error("Invalid VM zone inventory");
      for (const instance of scope.instances || []) names.add(`${scopeName.slice(6)}/${instance.name}`);
      if (scope.warning && scope.warning.code !== "NO_RESULTS_ON_PAGE") throw new Error("Incomplete VM inventory");
    }
    return names;
  }
  async function transition(key, entry, state) {
    await firestore.runTransaction(async tx => {
      const entries = readPool(await tx.get(pool));
      const doc = await tx.get(jobRef(key));
      const job = doc.exists ? doc.data() : {};
      if (entries[key]?.token !== entry.token || entries[key]?.state !== entry.state) return;
      if (state === "released") {
        archiveBootstrap(job, entries[key]);
        delete entries[key];
        tx.set(jobRef(key), { ...job, state: job.done ? "completed" : "waiting" });
      } else entries[key] = { ...entries[key], state };
      tx.set(pool, { entries: JSON.stringify(entries) });
    });
  }
  async function reconcile() {
    // Filtered inventory is useful for capacity admission, not proof of absence.
    // Only the exact-GET ownership-bound recovery component may release slots.
    if (!recovery) return {status: 'preserved', reason: 'recovery_unwired'};
    if (!Number.isSafeInteger(recoveryBatchSize) || recoveryBatchSize < 1 || recoveryBatchSize > 100)
      throw new Error('Invalid recovery batch');
    const keys = await firestore.runTransaction(async tx => {
      const [poolDoc, cursorDoc] = await Promise.all([tx.get(pool), tx.get(cursor)]);
      const all = Object.keys(readPool(poolDoc)).sort();
      const after = cursorDoc.exists ? cursorDoc.data().after : '';
      if (typeof after !== 'string') throw new Error('Invalid recovery cursor');
      const ordered = [...all.filter(key => key > after), ...all.filter(key => key <= after)];
      const batch = ordered.slice(0, recoveryBatchSize);
      if (batch.length) tx.set(cursor, {after: batch[batch.length - 1]});
      return batch;
    });
    const outcomes = [];
    for (const key of keys) {
      try {
        const outcome = await recovery.hydrateAllocation(key);
        outcomes.push(outcome.status === 'absent' ? await recovery.recoverAbsentAllocation(key) : outcome);
      } catch (_) {
        // One unqualified provider observation cannot starve every other entry.
        outcomes.push({status: 'preserved', reason: 'recovery_observation_failed'});
      }
    }
    return {status: 'reconciled', outcomes};
  }
  async function complete(event) {
    const {key} = identity(event);
    await firestore.runTransaction(async tx => {
      const entries = readPool(await tx.get(pool));
      const doc = await tx.get(jobRef(key));
      const job = { ...(doc.exists ? doc.data() : {}), done: true, state: "completed" };
      const expectedRunner = entries[key]?.runnerIdentity;
      if (event.verifiedWebhook === true && expectedRunner &&
          String(event.runner_id) === String(expectedRunner.id) && event.runner_name === expectedRunner.name) {
        job.completion = JSON.stringify({verifiedWebhook: true,
          runnerId: String(event.runner_id), runnerName: event.runner_name,
          jobId: String(event.job_id), runId: String(event.run_id),
          runAttempt: String(event.run_attempt || "1"),
          repositoryOwner: event.repo_owner, repositoryName: event.repo_name});
      }
      tx.set(jobRef(key), job);
      // Keep any pending/active VM charged until its absence is proved.
      if (entries[key]) entries[key].demandDone = true;
      tx.set(pool, { entries: JSON.stringify(entries) });
    });
  }
  async function provision(event) {
    const allocation = identity(event);
    await reconcile();
    const live = await inventory();
    const token = crypto.randomUUID();
    const result = await firestore.runTransaction(async tx => {
      const entries = readPool(await tx.get(pool));
      const doc = await tx.get(jobRef(allocation.key));
      const job = doc.exists ? doc.data() : {};
      if (job.done) return "completed";
      // Actual dispatch may be on another reserved allocation. A delayed queued
      // delivery must not create an additional VM for that already assigned job.
      if (job.executedBy) return "associated";
      const prior = entries[allocation.key];
      if (prior) return prior.state;
      if (job.bootstrap) throw new Error("Unarchived bootstrap receipt blocks new reservation");
      const charged = new Set([...live, ...Object.values(entries).map(e => `${e.zone}/${e.name}`)]);
      const demand = { ...job, done: false, event: JSON.stringify(event) };
      if (charged.size >= limit) {
        tx.set(jobRef(allocation.key), { ...demand, state: "waiting" });
        return "capacity";
      }
      const now = clock();
      if (!Number.isSafeInteger(now) || !Number.isSafeInteger(bootstrapTTLms) ||
          bootstrapTTLms < 1 || bootstrapTTLms > 900000 || !workerServiceAccountEmail ||
          !workerServiceAccountUniqueId || !brokerUrl) throw new Error('Invalid reservation profile');
      entries[allocation.key] = { name: allocation.name, token, state: "submitting", zone,
        project, workerServiceAccountEmail, workerServiceAccountUniqueId,
        brokerUrl, bootstrapExpiresAtMs: now + bootstrapTTLms, creationStarted: false };
      tx.set(pool, { entries: JSON.stringify(entries) });
      tx.set(jobRef(allocation.key), { ...demand, state: "pending" });
      return "reserved";
    });
    if (result !== "reserved") return result;
    let operation;
    try {
      operation = await createBuild(event, allocation, token);
    } catch (error) {
      // Only INVALID_ARGUMENT, PERMISSION_DENIED, RESOURCE_EXHAUSTED,
      // FAILED_PRECONDITION and UNAUTHENTICATED are definitive rejections here.
      // Other codes (including ALREADY_EXISTS, DEADLINE_EXCEEDED and INTERNAL),
      // missing build identity and persistence failures retain ambiguous acceptance.
      if (error instanceof BuildNotSubmitted || [3, 7, 8, 9, 16].includes(error.code)) await transition(allocation.key, { token, state: "submitting" }, "released");
      throw error;
    }
    // A persistence error after accepted submission is NOT a build rejection.
    // Retain the reservation even if the same numeric RPC code is returned.
    const buildId = operation.metadata?.build?.id;
    if (!buildId) throw new Error("Build accepted without durable build identity");
    await firestore.runTransaction(async tx => {
      const entries = readPool(await tx.get(pool));
      if (entries[allocation.key]?.token !== token) throw new Error("Reservation ownership lost");
      const state = entries[allocation.key].state === "submitting" ? "pending" : entries[allocation.key].state;
      entries[allocation.key] = { ...entries[allocation.key], state, buildId };
      tx.set(pool, { entries: JSON.stringify(entries) });
    });
    return "pending";
  }
  return { provision, reconcile, complete };
}
module.exports = { identity, coordinator, readPool, BuildNotSubmitted };
