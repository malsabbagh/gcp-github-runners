/**
 * Infrastructure Configuration
 *
 * This file contains configuration values that should be synchronized with Terraform.
 * To update these values:
 * 1. Run `terraform output infrastructure_config` to get current values
 * 2. Update the values below to match Terraform outputs
 * 3. Redeploy the Cloud Function
 *
 * Or better yet, generate this file automatically from Terraform outputs.
 */

const INFRASTRUCTURE_CONFIG = {
  // Project configuration
  PROJECT_ID:
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCP_PROJECT ||
    "PARITY_INPUT_064",

  // VM configuration - should match Terraform variables
  DEFAULT_ZONE: process.env.DEFAULT_ZONE || "us-central1-a",
  INSTANCE_TEMPLATE_NAME:
    process.env.INSTANCE_TEMPLATE_NAME || "github-runner-template",

  // Autoscaling configuration - should match Terraform variables
  MAX_RUNNER_VMS: parseInt(process.env.MAX_RUNNER_VMS || "2", 10),
  RUNNERS_PER_VM: parseInt(process.env.RUNNERS_PER_VM || "8", 10), // From Terraform runner_count variable

  // Resource limits
  MACHINE_TYPE: process.env.MACHINE_TYPE || "c2-standard-4", // From Terraform machine_type variable

  // Thresholds for autoscaling decisions
  SCALE_UP_THRESHOLD: 0.8, // Scale up when 80% of runners are busy
  SCALE_DOWN_THRESHOLD: 0.3, // Scale down when less than 30% of runners are busy

  // Timeouts
  VM_CREATION_TIMEOUT_SECONDS: 600,
  JOB_COMPLETION_TIMEOUT_SECONDS: 3600,

  // Firestore collections (only for event processing)
  EVENTS_COLLECTION: "processed_events",
};

/**
 * Calculate autoscaling metrics based on GitHub API runner status
 */
async function calculateAutoscalingMetrics(octokit, owner, repo) {
  try {
    // Get current self-hosted runners from GitHub API
    const { data: runners } =
      await octokit.rest.actions.listSelfHostedRunnersForRepo({
        owner,
        repo,
      });

    // Filter runners by status
    const onlineRunners = runners.runners.filter(
      (runner) => runner.status === "online"
    );
    const busyRunners = onlineRunners.filter((runner) => runner.busy);
    const idleRunners = onlineRunners.filter((runner) => !runner.busy);

    // Calculate metrics
    const totalRunners = onlineRunners.length;
    const busyCount = busyRunners.length;
    const idleCount = idleRunners.length;
    const utilization = totalRunners > 0 ? busyCount / totalRunners : 0;

    // Determine scaling decisions
    const needScaleUp =
      idleCount === 0 && // No idle runners available
      totalRunners < INFRASTRUCTURE_CONFIG.MAX_RUNNER_VMS; // Haven't hit max limit

    const needScaleDown =
      utilization < INFRASTRUCTURE_CONFIG.SCALE_DOWN_THRESHOLD && // Low utilization
      totalRunners > 1 && // Keep at least one runner
      idleCount > 1; // Have multiple idle runners

    return {
      totalRunners,
      busyCount,
      idleCount,
      utilization,
      needScaleUp,
      needScaleDown,
      canScaleUp: totalRunners < INFRASTRUCTURE_CONFIG.MAX_RUNNER_VMS,
      reasons: {
        scaleUp: needScaleUp
          ? [
              `No idle runners available (${idleCount} idle)`,
              `Current runners: ${totalRunners} < Max runners: ${INFRASTRUCTURE_CONFIG.MAX_RUNNER_VMS}`,
            ]
          : [],
        scaleDown: needScaleDown
          ? [
              `Low utilization: ${(utilization * 100).toFixed(1)}% < ${(
                INFRASTRUCTURE_CONFIG.SCALE_DOWN_THRESHOLD * 100
              ).toFixed(1)}%`,
              `Multiple idle runners available: ${idleCount}`,
              `More than 1 runner: ${totalRunners}`,
            ]
          : [],
      },
    };
  } catch (error) {
    console.error("Error fetching runner status from GitHub API:", error);
    // Fallback to safe scaling decision on API error
    return {
      totalRunners: 0,
      busyCount: 0,
      idleCount: 0,
      utilization: 0,
      needScaleUp: true, // Scale up if we can't determine current state
      needScaleDown: false,
      canScaleUp: true,
      reasons: {
        scaleUp: ["GitHub API error - scaling up for safety"],
        scaleDown: [],
      },
      error: error.message,
    };
  }
}
/**
 * Validate that configuration is consistent with Terraform
 */
function validateConfiguration() {
  if (!Number.isSafeInteger(INFRASTRUCTURE_CONFIG.MAX_RUNNER_VMS) || INFRASTRUCTURE_CONFIG.MAX_RUNNER_VMS < 1) {
    throw new Error("MAX_RUNNER_VMS must be a positive integer");
  }
  const requiredEnvVars = ["GOOGLE_CLOUD_PROJECT"];
  const missingVars = requiredEnvVars.filter(
    (varName) => !process.env[varName]
  );

  if (missingVars.length > 0) {
    console.warn(
      `Warning: Missing environment variables: ${missingVars.join(", ")}`
    );
  }

  console.log("Infrastructure Configuration:");
  console.log(`  Project ID: ${INFRASTRUCTURE_CONFIG.PROJECT_ID}`);
  console.log(`  Zone: ${INFRASTRUCTURE_CONFIG.DEFAULT_ZONE}`);
  console.log(
    `  Instance Template: ${INFRASTRUCTURE_CONFIG.INSTANCE_TEMPLATE_NAME}`
  );
  console.log(`  Max VMs: ${INFRASTRUCTURE_CONFIG.MAX_RUNNER_VMS}`);
  console.log(`  Runners per VM: ${INFRASTRUCTURE_CONFIG.RUNNERS_PER_VM}`);
  console.log(`  Machine Type: ${INFRASTRUCTURE_CONFIG.MACHINE_TYPE}`);
}

module.exports = {
  INFRASTRUCTURE_CONFIG,
  calculateAutoscalingMetrics,
  validateConfiguration,
};
