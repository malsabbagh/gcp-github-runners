'use strict';
const {isDeepStrictEqual} = require('node:util');
const {createHash} = require('node:crypto');
const {validatedActualCompletion} = require('../webhook-handler/actual-job-association');
const {identity} = require('../webhook-handler/job-identity');
const parse = value => typeof value === 'string' ? JSON.parse(value) : null;
const id = value => /^[1-9][0-9]*$/.test(String(value)) && Number.isSafeInteger(Number(value));
const instanceId = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
function readKnownReceipt({entry, job}, {allowClaimed = false} = {}) {
  if (!entry || !job || entry.associationConflict || job.associationConflict) return null;
  const receipt = entry.bootstrap, mirror = parse(job.bootstrap);
  if (!receipt || receipt.version !== 1 || !isDeepStrictEqual(receipt, mirror) ||
      typeof receipt.claimId !== 'string' || !/^[a-f0-9-]{36}$/.test(receipt.claimId) || !id(receipt.runnerId) ||
      receipt.runnerName !== entry.name || typeof entry.token !== 'string' || !/^[a-f0-9-]{36}$/.test(entry.token) ||
      !instanceId(entry.instanceId) || typeof entry.instanceCreationTimestamp !== 'string' ||
      !Number.isFinite(Date.parse(entry.instanceCreationTimestamp))) return null;
  if (allowClaimed && !Array.isArray(receipt.runnerLabels)) return null;
  let identity;
  if (receipt.state === 'issued') {
    identity = entry.runnerIdentity;
    if (!identity || !id(identity.id) || String(identity.id) !== String(receipt.runnerId) ||
        identity.name !== receipt.runnerName) return null;
  } else if (allowClaimed && receipt.state === 'claimed' && receipt.mintOutcome === 'observed') {
    identity = {id: Number(receipt.runnerId), name: receipt.runnerName, labels: receipt.runnerLabels};
  } else return null;
  if (!Array.isArray(identity.labels) || !identity.labels.length ||
      identity.labels.some(x => typeof x !== 'string' || !x) ||
      new Set(identity.labels).size !== identity.labels.length ||
      (receipt.runnerLabels && !isDeepStrictEqual(receipt.runnerLabels, identity.labels))) return null;
  return {claimId: receipt.claimId, runnerId: Number(identity.id), runnerName: identity.name,
    labels: [...identity.labels], receiptSha256: createHash('sha256').update(JSON.stringify(receipt)).digest('hex')};
}
function legacyReservedCompletion({entry, job}, repositoryOwner, repositoryName) {
  const receipt = knownReceipt({entry, job});
  if (!receipt || entry.actualJob || job.actualJob || job.actualCompletion ||
      entry.demandDone !== true || job.done !== true) return false;
  const completion = parse(job.completion), event = parse(job.event);
  const sameId = (a, b) => id(a) && id(b) && String(a) === String(b);
  return typeof event?.repo_owner === 'string' && typeof event?.repo_name === 'string' &&
    event.repo_owner.toLowerCase() === repositoryOwner.toLowerCase() &&
    event.repo_name.toLowerCase() === repositoryName.toLowerCase() &&
    completion?.verifiedWebhook === true && sameId(completion.runnerId, receipt.runnerId) &&
    completion.runnerName === receipt.runnerName && completion.repositoryOwner === event.repo_owner &&
    completion.repositoryName === event.repo_name && sameId(completion.jobId, event.job_id) &&
    sameId(completion.runId, event.run_id) && sameId(completion.runAttempt, event.run_attempt || 1);
}
function readTerminalProof(state, repositoryOwner, repositoryName) {
  if (!['active', 'retiring', 'orphaned'].includes(state.entry?.state) ||
      !knownReceipt(state)) return false;
  const owner = identity(parse(state.job.event));
  if (owner.key !== state.key || owner.name !== state.entry.name) return false;
  const actual = state.entry.actualJob;
  if (actual || state.job.actualJob || state.job.actualCompletion) {
    return typeof actual?.repositoryOwner === 'string' && typeof actual?.repositoryName === 'string' &&
      actual.repositoryOwner.toLowerCase() === repositoryOwner.toLowerCase() &&
      actual.repositoryName.toLowerCase() === repositoryName.toLowerCase() && validatedActualCompletion(state);
  }
  return legacyReservedCompletion(state, repositoryOwner, repositoryName);
}
function knownReceipt(...args) {try {return readKnownReceipt(...args);} catch (_) {return null;}}
function terminalProof(...args) {try {return readTerminalProof(...args);} catch (_) {return false;}}
function binding(key, entry, receipt) {
  return {key, token: entry.token, name: entry.name, zone: entry.zone, project: entry.project,
    instanceId: entry.instanceId, instanceCreationTimestamp: entry.instanceCreationTimestamp,
    claimId: receipt.claimId, runnerId: receipt.runnerId, runnerName: receipt.runnerName,
    labels: [...receipt.labels], receiptSha256: receipt.receiptSha256};
}
module.exports = {knownReceipt, terminalProof, binding};
