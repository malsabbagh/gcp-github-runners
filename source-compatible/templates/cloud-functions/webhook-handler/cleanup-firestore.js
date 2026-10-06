/**
 * Firestore Legacy Data Cleanup Script
 *
 * This script helps clean up legacy Firestore collections that are no longer
 * needed after the GitHub API transition (August 2025).
 *
 * Usage:
 *   node cleanup-firestore.js              # View current state only
 *   node cleanup-firestore.js --cleanup    # Clean up legacy 'jobs' and 'vms' collections
 *
 * Collections:
 *   - jobs: LEGACY - Used to track job assignments (no longer needed)
 *   - vms: LEGACY - Used to track VM state (no longer needed)
 *   - processed_events: ACTIVE - Keeps webhook idempotency (preserved)
 *
 * After GitHub API transition, only 'processed_events' is needed for webhook
 * duplicate detection. The 'jobs' and 'vms' collections are safe to remove.
 */

// Script to clean up Firestore data for testing
const { Firestore } = require("@google-cloud/firestore");

const firestore = new Firestore({
  databaseId: "autoscaler-state",
});

const VMS_COLLECTION = "vms";
const JOBS_COLLECTION = "jobs";
const EVENTS_COLLECTION = "processed_events";

async function clearCollection(collectionName) {
  console.log(`Clearing collection: ${collectionName}`);
  const snapshot = await firestore.collection(collectionName).get();

  if (snapshot.empty) {
    console.log(`Collection ${collectionName} is already empty`);
    return;
  }

  const batch = firestore.batch();
  snapshot.docs.forEach((doc) => {
    batch.delete(doc.ref);
  });

  await batch.commit();
  console.log(
    `Deleted ${snapshot.docs.length} documents from ${collectionName}`
  );
}

async function listCollection(collectionName) {
  console.log(`\n=== Listing collection: ${collectionName} ===`);
  const snapshot = await firestore.collection(collectionName).get();

  if (snapshot.empty) {
    console.log(`Collection ${collectionName} is empty`);
    return;
  }

  snapshot.forEach((doc) => {
    console.log(`Document ID: ${doc.id}`);
    console.log(`Data:`, JSON.stringify(doc.data(), null, 2));
    console.log("---");
  });
}

async function main() {
  try {
    const args = process.argv.slice(2);
    const shouldCleanup =
      args.includes("--cleanup") || args.includes("--delete-legacy");

    console.log("=== CURRENT FIRESTORE STATE ===");
    await listCollection(JOBS_COLLECTION);
    await listCollection(VMS_COLLECTION);
    await listCollection(EVENTS_COLLECTION);

    if (shouldCleanup) {
      console.log("\n=== CLEANING UP LEGACY FIRESTORE DATA ===");
      console.log("⚠️  This will DELETE legacy 'jobs' and 'vms' collections");
      console.log(
        "✅ The 'processed_events' collection will be PRESERVED for webhook idempotency"
      );

      await clearCollection(JOBS_COLLECTION);
      await clearCollection(VMS_COLLECTION);

      console.log(
        "\n✅ Legacy cleanup complete! Only 'processed_events' collection remains."
      );
      console.log(
        "💡 The infrastructure now uses GitHub API for all autoscaling decisions."
      );
    } else {
      console.log(
        "\n💡 To clean up legacy data, run with --cleanup or --delete-legacy flag"
      );
      console.log("   Example: node cleanup-firestore.js --cleanup");
    }

    console.log("\n=== STATE CHECK COMPLETE ===");
  } catch (error) {
    console.error("Error:", error);
  }
}

main();
