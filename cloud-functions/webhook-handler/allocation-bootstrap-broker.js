'use strict';
const { randomUUID } = require('node:crypto');
const { BootstrapDenied, BootstrapMintFailure, redactedBootstrapCode, assertRequest, saneNow } = require('./allocation-bootstrap-store');

function createAllocationBootstrapBroker({ store, verifyIdentity, github,
  clock = Date.now, newClaimId = randomUUID, jitProviderLifetimeQualified = false }) {
  if (!store || !['readBootstrapAllocation', 'claimBootstrap', 'recordBootstrapMintEvidence', 'commitBootstrapReceipt']
    .every(k => typeof store[k] === 'function') || typeof verifyIdentity !== 'function' ||
    !github || typeof github.mintJit !== 'function') throw new BootstrapDenied('BOOTSTRAP_INVALID');
  return {
    async inspect(request, assertion) {
      try {
        assertRequest(request);
        if (jitProviderLifetimeQualified !== true) throw new BootstrapDenied('BOOTSTRAP_UNAVAILABLE');
        const allocation = await store.readBootstrapAllocation(request);
        await verifyIdentity(assertion, allocation);
        return { ok: true, ready: true };
      } catch (error) {
        return { ok: false, code: redactedBootstrapCode(error) };
      }
    },
    async exchange(request, assertion) {
      try {
        assertRequest(request);
        // Explicit qualification lock: no accidental deployment of unevidenced JIT
        // lifetime/response assumptions merely because SDK methods exist.
        if (jitProviderLifetimeQualified !== true) throw new BootstrapDenied('BOOTSTRAP_UNAVAILABLE');
        const initialNow = saneNow(clock);
        const allocation = await store.readBootstrapAllocation(request);
        const identity = await verifyIdentity(assertion, allocation);
        if (saneNow(clock) < initialNow) throw new BootstrapDenied('BOOTSTRAP_UNAVAILABLE');
        const claimId = newClaimId();
        const claimed = await store.claimBootstrap(request, identity, claimId);
        // One durable consumption before the provider side effect. No exception
        // below this point restores unused issuance or frees charged capacity.
        let material;
        try {
          material = await github.mintJit({ runnerName: claimed.name,
            labels: claimed.registeredLabels, bootstrapExpiresAtMs: claimed.bootstrapExpiresAtMs });
        } catch (error) {
          if (error instanceof BootstrapMintFailure)
            await store.recordBootstrapMintEvidence(request, claimId, error.observedRunner);
          throw error;
        }
        // Retain known provider identity before rejecting material or deadlines.
        // The store accepts identity evidence only under the same durable claim.
        await store.recordBootstrapMintEvidence(request, claimId, material);
        const mintedAt = saneNow(clock);
        if (mintedAt < claimed.claimedAtMs || !material ||
            typeof material.encodedJitConfig !== 'string' || !material.encodedJitConfig ||
            material.encodedJitConfig.length > 65536 ||
            !Number.isSafeInteger(material.releaseBeforeMs) || material.releaseBeforeMs <= mintedAt)
          throw new BootstrapDenied('BOOTSTRAP_UNAVAILABLE');
        // Reinspect the live instance after async provider mint; status/incarnation
        // and durable cancellation are checked again before releasing material.
        const freshIdentity = await verifyIdentity(assertion, claimed);
        const receipt = await store.commitBootstrapReceipt(request, freshIdentity, claimId,
          material, mintedAt);
        return { ok: true, allocationKey: receipt.allocationKey, instanceId: receipt.instanceId,
          incarnation: receipt.incarnation, runnerId: material.runnerId,
          runnerName: material.runnerName, encodedJitConfig: material.encodedJitConfig,
          releaseBeforeMs: material.releaseBeforeMs,
          providerExpiresAtMs: material.providerExpiresAtMs };
      } catch (error) {
        return { ok: false, code: redactedBootstrapCode(error) };
      }
    }
  };
}
module.exports = { createAllocationBootstrapBroker };
