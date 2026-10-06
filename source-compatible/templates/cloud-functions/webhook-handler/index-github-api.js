const { CloudBuildClient } = require("@google-cloud/cloudbuild");
const { SecretManagerServiceClient } = require("@google-cloud/secret-manager");
const { Firestore } = require("@google-cloud/firestore");
const { Octokit } = require("@octokit/rest");
const functions = require("@google-cloud/functions-framework");
const crypto = require("crypto");
const {
  INFRASTRUCTURE_CONFIG,
  calculateAutoscalingMetrics,
  validateConfiguration,
} = require("./infrastructure-config");

// Initialize clients
const cloudBuild = new CloudBuildClient();
const secretManager = new SecretManagerServiceClient();
const firestore = new Firestore({
  databaseId: "autoscaler-state",
});

// Validate configuration on startup
validateConfiguration();

// Configuration from infrastructure config
const PROJECT_ID = INFRASTRUCTURE_CONFIG.PROJECT_ID;
const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const DEFAULT_ZONE = INFRASTRUCTURE_CONFIG.DEFAULT_ZONE;
const INSTANCE_TEMPLATE_NAME = INFRASTRUCTURE_CONFIG.INSTANCE_TEMPLATE_NAME;

// Log the project ID for debugging
console.log(`Using Project ID: ${PROJECT_ID}`);

// Firestore collections (only for event processing)
const EVENTS_COLLECTION = INFRASTRUCTURE_CONFIG.EVENTS_COLLECTION;

// Configuration
const MAX_RUNNER_VMS = INFRASTRUCTURE_CONFIG.MAX_RUNNER_VMS;

/**
 * Check if an event has already been processed (for idempotency)
 */
async function isEventProcessed(eventId) {
  try {
    const doc = await firestore
      .collection(EVENTS_COLLECTION)
      .doc(eventId)
      .get();
    return doc.exists;
  } catch (error) {
    console.error("Error checking if event is processed:", error);
    return false; // Assume not processed on error
  }
}

/**
 * Mark an event as processed
 */
async function markEventProcessed(eventId, eventData) {
  try {
    await firestore.collection(EVENTS_COLLECTION).doc(eventId).set({
      event_id: eventId,
      processed_at: new Date(),
      event_data: eventData,
    });
  } catch (error) {
    console.error("Error marking event as processed:", error);
    throw error;
  }
}

/**
 * Get GitHub token from Secret Manager
 */
async function getGitHubToken() {
  try {
    const tokenName = process.env.GITHUB_TOKEN_SECRET_NAME || "github-token";
    const [version] = await secretManager.accessSecretVersion({
      name: `projects/${PROJECT_ID}/secrets/${tokenName}/versions/latest`,
    });
    return version.payload.data.toString();
  } catch (error) {
    console.error("Error getting GitHub token:", error);
    throw error;
  }
}

/**
 * Create GitHub API client with authentication
 */
async function createGitHubClient() {
  try {
    const token = await getGitHubToken();
    return new Octokit({
      auth: token,
    });
  } catch (error) {
    console.error("Failed to create GitHub client:", error);
    throw error;
  }
}

/**
 * Generate a GitHub runner registration token
 */
async function generateRunnerToken(owner, repo) {
  try {
    const octokit = await createGitHubClient();
    const { data } = await octokit.rest.actions.createRegistrationTokenForRepo({
      owner,
      repo,
    });
    return data.token;
  } catch (error) {
    console.error("Error generating runner token:", error);
    throw error;
  }
}

/**
 * Get current state using GitHub API for runners
 */
async function getCurrentState(owner, repo) {
  try {
    const octokit = await createGitHubClient();

    // Get metrics from GitHub API
    const metrics = await calculateAutoscalingMetrics(octokit, owner, repo);

    console.log("Current Infrastructure State (GitHub API):");
    console.log(
      `  Runners: ${metrics.totalRunners} total (${metrics.busyCount} busy, ${metrics.idleCount} idle)`
    );
    console.log(`  Utilization: ${(metrics.utilization * 100).toFixed(1)}%`);
    console.log(
      `  Scale decisions: Up=${metrics.needScaleUp}, Down=${metrics.needScaleDown}`
    );

    if (metrics.error) {
      console.warn(`  API Error: ${metrics.error}`);
    }

    return {
      totalRunners: metrics.totalRunners,
      busyRunners: metrics.busyCount,
      idleRunners: metrics.idleCount,
      utilization: metrics.utilization,
      needScaleUp: metrics.needScaleUp,
      needScaleDown: metrics.needScaleDown,
      metrics,
    };
  } catch (error) {
    console.error("Error getting current state:", error);
    // Fallback to safe scaling decision
    return {
      totalRunners: 0,
      busyRunners: 0,
      idleRunners: 0,
      utilization: 0,
      needScaleUp: true, // Scale up on error for safety
      needScaleDown: false,
      error: error.message,
    };
  }
}

/**
 * Verify GitHub webhook signature
 */
function verifySignature(payload, signature, secret) {
  if (!signature || !secret) {
    return false;
  }

  if (!signature.startsWith("sha256=")) {
    return false;
  }

  const expectedSignature =
    "sha256=" +
    crypto.createHmac("sha256", secret).update(payload, "utf8").digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  } catch (error) {
    console.error("Signature verification failed:", error.message);
    return false;
  }
}

/**
 * Create a new VM instance for runners using configurable instance template
 */
async function createVMInstance(owner, repo) {
  try {
    const vmId = `runner-${Date.now()}-${Math.random()
      .toString(36)
      .substring(2, 8)}`;
    const runnerToken = await generateRunnerToken(owner, repo);

    const build = {
      steps: [
        {
          name: "PARITY_INPUT_229",
          args: [
            "compute",
            "instances",
            "create",
            vmId,
            `--source-instance-template=${INSTANCE_TEMPLATE_NAME}`,
            `--zone=${DEFAULT_ZONE}`,
            "--metadata",
            `github-token=${runnerToken},github-repo=${owner}/${repo},vm-id=${vmId},repo-owner=${owner}`,
            "--labels",
            `repo=${repo.toLowerCase()},owner=${owner.toLowerCase()}`,
          ],
        },
      ],
      options: {
        logging: "CLOUD_LOGGING_ONLY",
      },
    };

    console.log(`Creating VM ${vmId} using template ${INSTANCE_TEMPLATE_NAME}`);
    const [operation] = await cloudBuild.createBuild({
      projectId: PROJECT_ID,
      build,
    });

    console.log(`Build started: ${operation.name}`);
    return vmId;
  } catch (error) {
    console.error("Error creating VM instance:", error);
    throw error;
  }
}

/**
 * Calculate required number of new VMs based on GitHub API metrics
 */
function calculateRequiredVMs(state) {
  if (!state.metrics) {
    console.warn("No metrics available for VM calculation");
    return 0;
  }

  const { metrics } = state;

  console.log("=== VM Scaling Decision ===");
  console.log(`Scale Up Needed: ${metrics.needScaleUp}`);
  console.log(`Scale Down Needed: ${metrics.needScaleDown}`);
  console.log(`Can Scale Up: ${metrics.canScaleUp}`);

  if (metrics.needScaleUp && metrics.canScaleUp) {
    console.log("Decision: Creating 1 new VM");
    console.log("Reasons:", metrics.reasons.scaleUp);
    return 1;
  } else if (metrics.needScaleDown) {
    console.log("Decision: Scaling down (handled by cleanup function)");
    console.log("Reasons:", metrics.reasons.scaleDown);
    return 0;
  } else {
    console.log("Decision: No scaling needed");
    return 0;
  }
}

/**
 * Process workflow_job events for autoscaling
 */
async function processWorkflowJobEvent(eventData) {
  const jobId = `${eventData.repo_owner}-${eventData.repo_name}-${eventData.run_id}-${eventData.job_id}`;

  try {
    console.log(
      `Processing workflow_job event: ${eventData.action} for job ${jobId}`
    );

    if (eventData.action === "queued") {
      // Get current infrastructure state from GitHub API
      const state = await getCurrentState(
        eventData.repo_owner,
        eventData.repo_name
      );

      console.log(`=== Autoscaling Analysis ===`);
      console.log(`Current state:`, {
        totalRunners: state.totalRunners,
        busyRunners: state.busyRunners,
        idleRunners: state.idleRunners,
        utilization: `${(state.utilization * 100).toFixed(1)}%`,
      });

      // Calculate how many new VMs we need based on GitHub API metrics
      const requiredVMs = calculateRequiredVMs(state);

      if (requiredVMs > 0) {
        console.log(`Creating ${requiredVMs} new VM(s) for job ${jobId}`);

        // Create the required number of VMs
        for (let i = 0; i < requiredVMs; i++) {
          try {
            const vmId = await createVMInstance(
              eventData.repo_owner,
              eventData.repo_name
            );
            console.log(`Created VM ${vmId} for scaling`);
          } catch (vmError) {
            console.error(`Failed to create VM ${i + 1}:`, vmError);
            // Continue trying to create other VMs
          }
        }
      } else {
        console.log(
          `No new VMs needed. Current runners can handle the workload.`
        );
      }
    } else if (eventData.action === "completed") {
      console.log(
        `Job ${jobId} completed - GitHub runner will become available`
      );
    } else if (eventData.action === "cancelled") {
      console.log(
        `Job ${jobId} cancelled - GitHub runner will become available`
      );
    }
  } catch (error) {
    console.error("Error processing workflow_job event:", error);
    throw error;
  }
}

/**
 * Process workflow_run events for repository management
 */
async function processWorkflowRunEvent(eventData) {
  try {
    console.log(
      `Processing workflow_run event: ${eventData.action} for run ${eventData.run_id}`
    );

    if (eventData.action === "completed") {
      console.log(
        `Workflow run ${eventData.run_id} completed - cleanup function will handle idle runners`
      );
    }
  } catch (error) {
    console.error("Error processing workflow_run event:", error);
    throw error;
  }
}

/**
 * Main webhook handler
 */
async function webhookHandler(req, res) {
  try {
    // Verify webhook signature
    const signature = req.headers["x-hub-signature-256"];
    const payload = JSON.stringify(req.body);

    if (
      WEBHOOK_SECRET &&
      !verifySignature(payload, signature, WEBHOOK_SECRET)
    ) {
      console.error("Invalid webhook signature");
      return res.status(401).send("Unauthorized");
    }

    const event = req.headers["x-github-event"];
    const eventData = req.body;

    console.log(`Received GitHub webhook: ${event}`);

    // Create a unique event ID for idempotency
    const eventId = `${event}-${eventData.action || "unknown"}-${
      eventData.repository?.id || "no-repo"
    }-${Date.now()}`;

    // Check if we've already processed this event
    if (await isEventProcessed(eventId)) {
      console.log(`Event ${eventId} already processed, skipping`);
      return res.status(200).send("Event already processed");
    }

    // Process different types of events
    if (event === "workflow_job") {
      const processedEventData = {
        action: eventData.action,
        job_id: eventData.workflow_job?.id,
        run_id: eventData.workflow_job?.run_id,
        repo_owner: eventData.repository?.owner?.login,
        repo_name: eventData.repository?.name,
        runner_name: eventData.workflow_job?.runner_name,
        labels: eventData.workflow_job?.labels || [],
      };

      // Only process events for self-hosted runners
      if (
        processedEventData.labels.includes("self-hosted") &&
        processedEventData.action
      ) {
        // Mark event as processed before doing the work
        await markEventProcessed(eventId, processedEventData);

        // Process the workflow job event
        await processWorkflowJobEvent(processedEventData);
      } else {
        console.log("Skipping event - not for self-hosted runners");
      }
    } else if (event === "workflow_run") {
      const processedEventData = {
        action: eventData.action,
        run_id: eventData.workflow_run?.id,
        repo_owner: eventData.repository?.owner?.login,
        repo_name: eventData.repository?.name,
        conclusion: eventData.workflow_run?.conclusion,
      };

      if (processedEventData.action) {
        // Mark event as processed
        await markEventProcessed(eventId, processedEventData);

        // Process the workflow run event
        await processWorkflowRunEvent(processedEventData);
      }
    } else {
      console.log(`Unhandled event type: ${event}`);
    }

    res.status(200).send("Webhook processed successfully");
  } catch (error) {
    console.error("Error processing webhook:", error);
    res.status(500).send("Internal server error");
  }
}

// Register the function
functions.http("webhookHandler", webhookHandler);

// Export functions for testing
module.exports = {
  webhookHandler,
  verifySignature,
  createVMInstance,
  isEventProcessed,
  markEventProcessed,
  getCurrentState,
  processWorkflowJobEvent,
  processWorkflowRunEvent,
  calculateRequiredVMs,
  getGitHubToken,
  generateRunnerToken,
  createGitHubClient,
};
