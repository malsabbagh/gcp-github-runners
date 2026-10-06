"use strict";
// Independently authored profile adaptation. No source private fallbacks.
function required(env, name, pattern) {
  const value = env[name];
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}
function bounded(env, name, fallback, maximum) {
  const text = env[name] === undefined ? String(fallback) : env[name];
  if (!/^[1-9][0-9]*$/.test(text)) throw new Error(`Invalid ${name}`);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value > maximum) throw new Error(`Invalid ${name}`);
  return value;
}
function readInfrastructureConfiguration(env = process.env) {
const project = required(env, "GOOGLE_CLOUD_PROJECT", /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/);
return Object.freeze({
  PROJECT_ID: project,
  BOOTSTRAP_TTL_MS: bounded(env, "BOOTSTRAP_TTL_MS", 600000, 900000),
  RECONCILIATION_BATCH_SIZE: bounded(env, "RECONCILIATION_BATCH_SIZE", 20, 100),
  DEFAULT_ZONE: required(env, "DEFAULT_ZONE", /^[a-z]+(?:-[a-z]+)+[0-9]+-[a-z]$/),
  INSTANCE_TEMPLATE_NAME: required(env, "INSTANCE_TEMPLATE_NAME", /^[a-z][a-z0-9-]{0,61}[a-z0-9]$/),
  MAX_RUNNER_VMS: Number(required(env, "MAX_RUNNER_VMS", /^[1-9][0-9]{0,3}$/)),
  RUNNERS_PER_VM: 1,
  FIRESTORE_DATABASE_ID: required(env, "FIRESTORE_DATABASE_ID", /^[a-z][a-z0-9-]{2,62}$/),
  VM_CREATION_TIMEOUT_SECONDS: Number(required(env, "VM_CREATION_TIMEOUT_SECONDS", /^(?:[6-9][0-9]|[1-9][0-9]{2}|1[0-7][0-9]{2}|1800)$/)),
  EVENTS_COLLECTION: "processed_events",
  WEBHOOK_SECRET_VERSION: required(env, "GITHUB_WEBHOOK_SECRET_VERSION", /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/secrets\/[A-Za-z0-9_-]{1,255}\/versions\/[1-9][0-9]*$/),
  BUILDER_IMAGE: required(env, "BUILDER_IMAGE", /^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$/),
  WORKER_SERVICE_ACCOUNT: required(env, "WORKER_SERVICE_ACCOUNT", /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/),
  WORKER_SERVICE_ACCOUNT_UNIQUE_ID: required(env, "WORKER_SERVICE_ACCOUNT_UNIQUE_ID", /^[1-9][0-9]{5,30}$/),
  ALLOCATION_BROKER_URL: required(env, "ALLOCATION_BROKER_URL", /^https:\/\/[a-z0-9.-]+(?:\/[A-Za-z0-9/_-]*)?$/),
});
}
function validateConfiguration(env = process.env, INFRASTRUCTURE_CONFIG = readInfrastructureConfiguration(env)) {
  if (env.RUNNERS_PER_VM && env.RUNNERS_PER_VM !== "1") throw new Error("Only one-job workers are supported");
  required(env, "GITHUB_REPO_OWNER", /^[A-Za-z0-9-]{1,39}$/);
  required(env, "GITHUB_REPO_NAME", /^[A-Za-z0-9_.-]{1,100}$/);
  required(env, "CLOUDBUILD_SERVICE_ACCOUNT", /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/);
  if (env.CLOUDBUILD_SERVICE_ACCOUNT === INFRASTRUCTURE_CONFIG.WORKER_SERVICE_ACCOUNT) throw new Error("Build and worker identities must differ");
  if (!INFRASTRUCTURE_CONFIG.WEBHOOK_SECRET_VERSION.startsWith(`projects/${INFRASTRUCTURE_CONFIG.PROJECT_ID}/`)) throw new Error("Secret project mismatch");
  if (!INFRASTRUCTURE_CONFIG.WORKER_SERVICE_ACCOUNT.endsWith(`@${INFRASTRUCTURE_CONFIG.PROJECT_ID}.iam.gserviceaccount.com`)) throw new Error("Worker project mismatch");
}
module.exports = { readInfrastructureConfiguration, validateConfiguration };
Object.defineProperty(module.exports, "INFRASTRUCTURE_CONFIG", {get: () => readInfrastructureConfiguration()});
