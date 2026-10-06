const crypto = require("crypto");
const terminalFailures = new Set(["FAILURE", "INTERNAL_ERROR", "TIMEOUT", "CANCELLED", "EXPIRED"]);

function identity(event) {
  if ([event.run_id, event.job_id, event.run_attempt].some(value => typeof value === "number" && !Number.isSafeInteger(value))) throw new Error("Unsafe numeric job identity");
  const fields = [event.repo_owner, event.repo_name, event.run_id, event.job_id, event.run_attempt || "1"].map(String);
  if (!/^[A-Za-z0-9-]{1,39}$/.test(fields[0]) || !/^[A-Za-z0-9_.-]{1,100}$/.test(fields[1]) || !fields.slice(2).every(value => /^[1-9][0-9]*$/.test(value))) throw new Error("Invalid job identity");
  const key = crypto.createHash("sha256").update(JSON.stringify(fields)).digest("hex");
  const prefix = `runner-${fields[0]}-${fields[1]}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 38).replace(/-+$/, "");
  return { key, name: `${prefix}-${key.slice(0, 24)}` };
}
function readPool(doc) {
  if (!doc.exists) return {};
  const entries = JSON.parse(doc.data().entries);
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw new Error("Invalid provisioning pool");
  return entries;
}
function coordinator({ firestore, cloudBuild, compute, project, zone, limit, createBuild }) {
  const pool = firestore.collection("provisioning_pools").doc("global");
  const jobRef = key => firestore.collection("job_provisioning").doc(key);
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
        delete entries[key];
        tx.set(jobRef(key), { ...job, state: job.done ? "completed" : "waiting" });
      } else entries[key] = { ...entries[key], state };
      tx.set(pool, { entries: JSON.stringify(entries) });
    });
  }
  async function reconcile() {
    const snapshot = readPool(await pool.get());
    const present = await inventory();
    for (const [key, entry] of Object.entries(snapshot)) {
      if (entry.state === "active" && !present.has(`${entry.zone}/${entry.name}`)) {
        await transition(key, entry, "released");
        continue;
      }
      if (entry.state !== "pending" || !entry.buildId) continue;
      const [build] = await cloudBuild.getBuild({ projectId: project, id: entry.buildId });
      if (build.status !== "SUCCESS" && !terminalFailures.has(build.status)) continue;
      const live = await inventory();
      const state = live.has(`${entry.zone}/${entry.name}`) ? "active" : build.status === "SUCCESS" ? "unknown" : "released";
      await transition(key, entry, state);
    }
  }
  async function complete(event) {
    const {key} = identity(event);
    await firestore.runTransaction(async tx => {
      const entries = readPool(await tx.get(pool));
      const doc = await tx.get(jobRef(key));
      tx.set(jobRef(key), { ...(doc.exists ? doc.data() : {}), done: true, state: "completed" });
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
      const prior = entries[allocation.key];
      if (prior) return prior.state;
      const charged = new Set([...live, ...Object.values(entries).map(e => `${e.zone}/${e.name}`)]);
      const demand = { ...job, done: false, event: JSON.stringify(event) };
      if (charged.size >= limit) {
        tx.set(jobRef(allocation.key), { ...demand, state: "waiting" });
        return "capacity";
      }
      entries[allocation.key] = { name: allocation.name, token, state: "submitting", zone };
      tx.set(pool, { entries: JSON.stringify(entries) });
      tx.set(jobRef(allocation.key), { ...demand, state: "pending" });
      return "reserved";
    });
    if (result !== "reserved") return result;
    try {
      const operation = await createBuild(event, allocation, token);
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
    } catch (error) {
      // Only INVALID_ARGUMENT, PERMISSION_DENIED, RESOURCE_EXHAUSTED,
      // FAILED_PRECONDITION and UNAUTHENTICATED are definitive rejections here.
      // Other codes (including ALREADY_EXISTS, DEADLINE_EXCEEDED and INTERNAL),
      // missing build identity and persistence failures retain ambiguous acceptance.
      if ([3, 7, 8, 9, 16].includes(error.code)) await transition(allocation.key, { token, state: "submitting" }, "released");
      throw error;
    }
  }
  return { provision, reconcile, complete };
}
module.exports = { identity, coordinator, readPool };
