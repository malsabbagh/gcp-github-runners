const { Firestore } = require("@google-cloud/firestore");

const firestore = new Firestore({
  databaseId: "autoscaler-state",
});

async function markCreatingVMsAsFailed() {
  try {
    console.log("=== MARKING CREATING VMs AS FAILED ===");

    // Get the creating VMs
    const vmIds = [
      "16493ce8-a458-43b7-8a6a-107f20c5e63f",
      "4b07842e-f200-46f4-8d42-ac4be4d9c4c6",
    ];

    for (const vmId of vmIds) {
      await firestore.collection("vms").doc(vmId).update({
        status: "failed",
        failure_reason:
          "Ubuntu image family update - marked as failed for testing",
        updated_at: new Date(),
      });
      console.log(`✅ Marked VM ${vmId} as failed`);
    }

    console.log("=== CLEANUP COMPLETE ===");
    process.exit(0);
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

markCreatingVMsAsFailed();
