// Clean up stale VM records in Firestore
const { Firestore } = require("@google-cloud/firestore");

// Initialize Firestore with explicit project ID
const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || "PARITY_INPUT_064";
const firestore = new Firestore({
  projectId: PROJECT_ID,
  databaseId: "autoscaler-state",
});
const VMS_COLLECTION = "vms";

async function cleanupStaleVMs() {
  console.log("=== CLEANING UP STALE VM RECORDS ===");

  try {
    // Get all VMs
    const vmsSnapshot = await firestore.collection(VMS_COLLECTION).get();

    if (vmsSnapshot.empty) {
      console.log("No VM records found in Firestore");
      return;
    }

    console.log(`Found ${vmsSnapshot.size} VM records in Firestore`);

    // Check each VM and clean up stale "creating" status VMs
    const now = new Date();
    const staleThresholdMinutes = 30; // Consider VMs stale if creating for more than 30 minutes

    for (const doc of vmsSnapshot.docs) {
      const vm = doc.data();
      console.log(`\nChecking VM: ${vm.vm_id}`);
      console.log(`Status: ${vm.status}`);
      console.log(`Created: ${vm.created_at.toDate()}`);

      if (vm.status === "creating") {
        const createdAt = vm.created_at.toDate();
        const ageMinutes = (now - createdAt) / (1000 * 60);

        console.log(
          `VM has been in "creating" status for ${ageMinutes.toFixed(
            1
          )} minutes`
        );

        if (ageMinutes > staleThresholdMinutes) {
          console.log(
            `🧹 Cleaning up stale VM: ${
              vm.vm_id
            } (stuck in creating for ${ageMinutes.toFixed(1)} minutes)`
          );

          // Update status to failed
          await firestore.collection(VMS_COLLECTION).doc(doc.id).update({
            status: "failed",
            updated_at: new Date(),
            failure_reason:
              "Stale VM record - stuck in creating status for too long",
          });

          console.log(`✅ Updated VM ${vm.vm_id} status to 'failed'`);
        } else {
          console.log(`VM is still within acceptable creating time threshold`);
        }
      } else {
        console.log(`VM status is ${vm.status} - no action needed`);
      }
    }
  } catch (error) {
    console.error("Error cleaning up stale VMs:", error);
  }

  console.log("\n=== CLEANUP COMPLETE ===");
}

// Run the cleanup
cleanupStaleVMs().catch(console.error);
