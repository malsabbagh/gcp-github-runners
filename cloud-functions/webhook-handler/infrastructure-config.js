"use strict";
// Independently authored profile adaptation. No source private fallbacks.
function required(name, pattern) {
  const value = process.env[name];
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}
function bounded(name, fallback, maximum) {
  const text = process.env[name] === undefined ? String(fallback) : process.env[name];
  if (!/^[1-9][0-9]*$/.test(text)) throw new Error(`Invalid ${name}`);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value > maximum) throw new Error(`Invalid ${name}`);
  return value;
}
const project = required("GOOGLE_CLOUD_PROJECT", /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/);
const INFRASTRUCTURE_CONFIG = Object.freeze({
  PROJECT_ID: project,
  BOOTSTRAP_TTL_MS: bounded("BOOTSTRAP_TTL_MS", 600000, 900000),
  RECONCILIATION_BATCH_SIZE: bounded("RECONCILIATION_BATCH_SIZE", 20, 100),
  DEFAULT_ZONE: required("DEFAULT_ZONE", /^[a-z]+-[a-z]+[0-9]-[a-z]$/),
  INSTANCE_TEMPLATE_NAME: required("INSTANCE_TEMPLATE_NAME", /^[a-z][a-z0-9-]{0,61}[a-z0-9]$/),
  MAX_RUNNER_VMS: Number(required("MAX_RUNNER_VMS", /^[1-9][0-9]{0,3}$/)),
  RUNNERS_PER_VM: 1,
  FIRESTORE_DATABASE_ID: required("FIRESTORE_DATABASE_ID", /^[a-z][a-z0-9-]{2,62}$/),
  VM_CREATION_TIMEOUT_SECONDS: Number(required("VM_CREATION_TIMEOUT_SECONDS", /^(?:[6-9][0-9]|[1-9][0-9]{2}|1[0-7][0-9]{2}|1800)$/)),
  EVENTS_COLLECTION: "processed_events",
  WEBHOOK_SECRET_VERSION: required("GITHUB_WEBHOOK_SECRET_VERSION", /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/secrets\/[A-Za-z0-9_-]{1,255}\/versions\/[1-9][0-9]*$/),
  BUILDER_IMAGE: required("BUILDER_IMAGE", /^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$/),
  WORKER_SERVICE_ACCOUNT: required("WORKER_SERVICE_ACCOUNT", /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/),
  WORKER_SERVICE_ACCOUNT_UNIQUE_ID: required("WORKER_SERVICE_ACCOUNT_UNIQUE_ID", /^[1-9][0-9]{5,30}$/),
  ALLOCATION_BROKER_URL: required("ALLOCATION_BROKER_URL", /^https:\/\/[a-z0-9.-]+(?:\/[A-Za-z0-9/_-]*)?$/),
});
function validateConfiguration() {
  if (process.env.RUNNERS_PER_VM && process.env.RUNNERS_PER_VM !== "1") throw new Error("Only one-job workers are supported");
  required("GITHUB_REPO_OWNER", /^[A-Za-z0-9-]{1,39}$/);
  required("GITHUB_REPO_NAME", /^[A-Za-z0-9_.-]{1,100}$/);
  required("CLOUDBUILD_SERVICE_ACCOUNT", /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/);
  if (process.env.CLOUDBUILD_SERVICE_ACCOUNT === INFRASTRUCTURE_CONFIG.WORKER_SERVICE_ACCOUNT) throw new Error("Build and worker identities must differ");
  if (!INFRASTRUCTURE_CONFIG.WEBHOOK_SECRET_VERSION.startsWith(`projects/${project}/`)) throw new Error("Secret project mismatch");
  if (!INFRASTRUCTURE_CONFIG.WORKER_SERVICE_ACCOUNT.endsWith(`@${project}.iam.gserviceaccount.com`)) throw new Error("Worker project mismatch");
}
module.exports = { INFRASTRUCTURE_CONFIG, validateConfiguration };
