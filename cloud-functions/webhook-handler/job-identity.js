'use strict';
const crypto = require('node:crypto');

function identity(event) {
  if ([event.run_id, event.job_id, event.run_attempt].some(value => typeof value === "number" && !Number.isSafeInteger(value))) throw new Error("Unsafe numeric job identity");
  const fields = [event.repo_owner, event.repo_name, event.run_id, event.job_id, event.run_attempt || "1"].map(String);
  if (!/^[A-Za-z0-9-]{1,39}$/.test(fields[0]) || !/^[A-Za-z0-9_.-]{1,100}$/.test(fields[1]) || !fields.slice(2).every(value => /^[1-9][0-9]*$/.test(value))) throw new Error("Invalid job identity");
  const key = crypto.createHash("sha256").update(JSON.stringify(fields)).digest("hex");
  const prefix = `runner-${fields[0]}-${fields[1]}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 38).replace(/-+$/, "");
  return { key, name: `${prefix}-${key.slice(0, 24)}` };
}
module.exports = { identity };
