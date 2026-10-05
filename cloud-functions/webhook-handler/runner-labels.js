'use strict';
// Conservative common source contract for controller admission and App minting.
// Provider limits and actual runner label behavior still require qualification.
function validRegisteredLabels(labels) {
  return Array.isArray(labels) && labels.length > 1 && labels.length <= 16 &&
    labels.includes('self-hosted') && new Set(labels).size === labels.length &&
    labels.every(label => typeof label === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(label));
}
function validRoutingLabels(labels, routing) {
  return validRegisteredLabels(labels) && typeof routing === 'string' &&
    labels.includes(routing) &&
    !['self-hosted', 'linux', 'windows', 'macos', 'x64', 'arm', 'arm64'].includes(routing.toLowerCase());
}
module.exports = { validRegisteredLabels, validRoutingLabels };
