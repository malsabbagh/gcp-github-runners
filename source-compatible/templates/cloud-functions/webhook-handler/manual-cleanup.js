// Manual cleanup script to mark failed VMs as failed
const { Firestore } = require("@google-cloud/firestore");

const db = new Firestore({
  databaseId: "autoscaler-state",
});

async function markVMsAsFailed() {
  console.log("=== MARKING FAILED VMs AS FAILED ===");

  const vmIdsToFail = [
    "534504f0-3545-43de-979c-3c71b4e5a6b1",
    "b7573270-63fd-401b-ac1c-06b44aa2d7c1",
  ];

  for (const vmId of vmIdsToFail) {
    try {
      const vmRef = db.collection("vms").doc(vmId);
      await vmRef.update({
        status: "failed",
        failure_reason:
          "Labels validation failed - marked as failed for cleanup",
        updated_at: new Date(),
      });
      console.log(`✅ Marked VM ${vmId} as failed`);
    } catch (error) {
      console.error(`❌ Failed to update VM ${vmId}:`, error.message);
    }
  }

  console.log("=== CLEANUP COMPLETE ===");
}

markVMsAsFailed().catch(console.error);
