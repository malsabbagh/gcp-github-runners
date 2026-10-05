'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {CloudBuildClient} = require('@google-cloud/cloudbuild');
const functions = require('@google-cloud/functions-framework');
const MAX_AGE_HOURS = 8760;
const CLEANUP_SCRIPT = fs.readFileSync(path.join(__dirname, 'runner-cleanup.sh'), 'utf8');
const cloudBuild = new CloudBuildClient();
const safe = reason => new Error(reason);
function validAge(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_AGE_HOURS) throw safe('invalid_cleanup_age');
}
function configuration(env = process.env) {
  const project = env.PROJECT_ID || env.GOOGLE_CLOUD_PROJECT;
  const controller = env.CLEANUP_CONTROLLER_URL;
  const image = env.BUILDER_IMAGE;
  const identity = env.CLEANUP_SERVICE_ACCOUNT;
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project || '') ||
      !/^https:\/\/[^/?#]+(?:\/[^?#]*)?$/.test(controller || '') ||
      !/^\S+@sha256:[0-9a-f]{64}$/.test(image || '') ||
      !/^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(identity || '')) {
    throw safe('invalid_cleanup_configuration');
  }
  return {project, controller, image, identity};
}
async function cleanupOldRunners(maxAgeHours = 2) {
  validAge(maxAgeHours);
  const cfg = configuration();
  const [operation] = await cloudBuild.createBuild({projectId: cfg.project, build: {
    serviceAccount: `projects/${cfg.project}/serviceAccounts/${cfg.identity}`,
    steps: [{name: cfg.image, entrypoint: 'bash',
      args: ['-c', CLEANUP_SCRIPT.replace(/\$/g, '$$$$')],
      env: [`PROJECT_ID=${cfg.project}`, `MAX_AGE_HOURS=${maxAgeHours}`,
            `CLEANUP_CONTROLLER_URL=${cfg.controller}`]}],
    options: {logging: 'CLOUD_LOGGING_ONLY'}, timeout: '600s'
  }}).catch(() => {throw safe('cleanup_submission_uncertain');});
  if (!operation || typeof operation.name !== 'string') throw safe('cleanup_submission_uncertain');
  // Build acceptance is not retirement, runner absence or capacity release.
  return {status: 'submitted', operation: operation.name};
}

const {createRetirementController} = require('./retirement-controller');

functions.cloudEvent('scheduledCleanup', async () => {await cleanupOldRunners(2);});
functions.http('cleanupRunners', async (req, res) => {
  try {
    const age = req.query.maxAge === undefined ? 2 : (/^\d+$/.test(String(req.query.maxAge)) ? Number(req.query.maxAge) : NaN);
    validAge(age);
    await cleanupOldRunners(age);
    res.status(202).json({status: 'submitted'});
  } catch (_) {res.status(400).json({status: 'preserved', reason: 'cleanup_request_rejected'});}
});
module.exports = {cleanupOldRunners, createRetirementController, configuration, validAge};
