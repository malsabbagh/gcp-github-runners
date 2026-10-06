const { CloudBuildClient } = require("@google-cloud/cloudbuild");
const { SecretManagerServiceClient } = require("@google-cloud/secret-manager");
const { Firestore } = require("@google-cloud/firestore");
const { InstancesClient } = require("@google-cloud/compute");
const { Octokit } = require("@octokit/rest");
const functions = require("@google-cloud/functions-framework");
const crypto = require("crypto");
const fs = require("fs");
const { coordinator, identity } = require("./provisioning-state");
const {
  INFRASTRUCTURE_CONFIG,
  calculateAutoscalingMetrics,
  validateConfiguration,
} = require("./infrastructure-config");

// Initialize clients
const cloudBuild = new CloudBuildClient();
const computeClient = new InstancesClient();
const secretManager = new SecretManagerServiceClient({
  projectId:
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCP_PROJECT ||
    "PARITY_INPUT_064",
});
const firestore = new Firestore({
  databaseId: "autoscaler-state",
});

// Validate configuration on startup
validateConfiguration();

// Configuration from infrastructure config
const PROJECT_ID = INFRASTRUCTURE_CONFIG.PROJECT_ID;
const WEBHOOK_SECRET_NAME =
  process.env.GITHUB_WEBHOOK_SECRET_NAME || "github-webhook-secret";
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
    return doc.exists && Boolean(doc.data().processed_at);
  } catch (error) {
    console.error("Error checking if event is processed:", error);
    throw error; // State-store errors must not bypass idempotency
  }
}

/**
 * Mark an event as processed
 */
async function markEventProcessed(eventId, eventData) {
  try {
    // Clean undefined values from eventData to avoid Firestore validation errors
    const cleanEventData = JSON.parse(
      JSON.stringify(eventData, (key, value) => {
        return value === undefined ? null : value;
      })
    );

    await firestore.collection(EVENTS_COLLECTION).doc(eventId).set({
      event_id: eventId,
      processed_at: new Date(),
      event_data: cleanEventData,
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
    const tokenName =
      process.env.GITHUB_TOKEN_SECRET_NAME || "github-runner-token";
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
 * Get webhook secret from Secret Manager
 */
async function getWebhookSecret() {
  try {
    // If secret provided directly via env var, use it
    if (process.env.GITHUB_WEBHOOK_SECRET) {
      return process.env.GITHUB_WEBHOOK_SECRET;
    }

    const [version] = await secretManager.accessSecretVersion({
      name: `projects/${PROJECT_ID}/secrets/${WEBHOOK_SECRET_NAME}/versions/latest`,
    });
    return version.payload.data.toString();
  } catch (error) {
    console.error("Error getting webhook secret:", error);
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
 * Utility: Count idle runners for a repo using GitHub REST API
 */
async function getIdleRunnersCount(owner, repo) {
  try {
    const token = await getGitHubToken();
    const resp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/runners`,
      {
        method: "GET",
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "PARITY_INPUT_115/1.0",
        },
      }
    );
    if (!resp.ok) {
      // Consume body to avoid unhandled promise
      if (resp.text) {
        await resp.text().catch(() => {});
      }
      return 0;
    }
    const data = await resp.json();
    const runners = data.runners || [];
    return runners.filter((r) => r.status === "online" && !r.busy).length;
  } catch (e) {
    return 0;
  }
}

/**
 * Verify GitHub webhook signature
 */
function verifySignature(payload, signature, secret) {
  if (typeof signature !== "string" || !/^sha256=[a-f0-9]{64}$/.test(signature) || !secret) {
    return false;
  }

  if (!signature.startsWith("sha256=")) {
    return false;
  }

  const expectedSignature =
    "sha256=" +
    crypto.createHmac("sha256", secret).update(payload, "utf8").digest("hex");

  try {
    // Ensure both signatures have the same length before comparing
    if (signature.length !== expectedSignature.length) {
      console.error("Signature length mismatch:", {
        received: signature.length,
        expected: expectedSignature.length,
      });
      return false;
    }

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
 * Acquire a distributed lock for VM creation to prevent race conditions
 */
async function acquireVMCreationLock(owner, repo, branch, timeoutMs = 30000) {
  // Sanitize branch name for Firestore document ID (replace invalid characters)
  const safeBranch = branch.replace(/[\/\\\.\#\$\[\]]/g, "-");
  const lockKey = `vm-creation-lock-${owner}-${repo}-${safeBranch}`;
  const lockDoc = firestore.collection("vm-creation-locks").doc(lockKey);
  const lockId = Math.random().toString(36).substring(2, 15);
  const expirationTime = Date.now() + timeoutMs;

  try {
    await firestore.runTransaction(async (transaction) => {
      const doc = await transaction.get(lockDoc);

      if (doc.exists) {
        const data = doc.data();
        // Check if lock is expired
        if (data.expirationTime > Date.now()) {
          throw new Error("Lock already held");
        }
      }

      // Acquire or renew the lock
      transaction.set(lockDoc, {
        lockId,
        expirationTime,
        acquiredAt: Date.now(),
        owner,
        repo,
        branch,
      });
    });

    console.log(`Acquired VM creation lock for ${owner}/${repo}/${branch}`);
    return lockId;
  } catch (error) {
    console.log(
      `Failed to acquire VM creation lock for ${owner}/${repo}/${branch}: ${error.message}`
    );
    if (error && error.message === "Lock already held") {
      return null;
    }
    throw error;
  }
}

/**
 * Release a distributed lock for VM creation
 */
async function releaseVMCreationLock(owner, repo, branch, lockId) {
  // Sanitize branch name for Firestore document ID (replace invalid characters)
  const safeBranch = branch.replace(/[\/\\\.\#\$\[\]]/g, "-");
  const lockKey = `vm-creation-lock-${owner}-${repo}-${safeBranch}`;
  const lockDoc = firestore.collection("vm-creation-locks").doc(lockKey);

  try {
    await firestore.runTransaction(async (transaction) => {
      const doc = await transaction.get(lockDoc);

      if (doc.exists) {
        const data = doc.data();
        // Only release if we own the lock
        if (data.lockId === lockId) {
          transaction.delete(lockDoc);
          console.log(
            `Released VM creation lock for ${owner}/${repo}/${branch}`
          );
        } else {
          console.log(
            `Lock ID mismatch, not releasing lock for ${owner}/${repo}/${branch}`
          );
        }
      }
    });
  } catch (error) {
    console.error(
      `Error releasing VM creation lock for ${owner}/${repo}/${branch}:`,
      error
    );
  }
}

/**
 * Check if a VM exists for a specific branch with idle capacity
 */
async function findBranchVMWithCapacity(owner, repo, branch) {
  try {
    const branchVmId = generateBranchVMId(owner, repo, branch);

    // Check if VM exists
    const [instance] = await computeClient.get({
      project: PROJECT_ID,
      zone: DEFAULT_ZONE,
      instance: branchVmId,
    });

    if (instance && instance.status === "RUNNING") {
      console.log(`Found existing VM ${branchVmId} for branch ${branch}`);

      // Check if this VM has idle capacity by checking GitHub runners
      const octokit = await createGitHubClient();
      const { data } = await octokit.rest.actions.listSelfHostedRunnersForRepo({
        owner,
        repo,
      });

      // Count runners on this specific VM (assuming runner names include VM ID)
      const vmRunners = (data.runners || []).filter(
        (runner) => runner.name && runner.name.includes(branchVmId)
      );

      const busyRunnersOnVM = vmRunners.filter((runner) => runner.busy).length;
      const totalRunnersOnVM = vmRunners.length;

      console.log(
        `VM ${branchVmId}: ${busyRunnersOnVM}/${totalRunnersOnVM} runners busy (capacity: ${INFRASTRUCTURE_CONFIG.RUNNERS_PER_VM})`
      );

      // VM has capacity if it has fewer than max runners or has idle runners
      const hasCapacity =
        totalRunnersOnVM < INFRASTRUCTURE_CONFIG.RUNNERS_PER_VM ||
        busyRunnersOnVM < totalRunnersOnVM;

      if (hasCapacity) {
        console.log(`VM ${branchVmId} has available capacity for new jobs`);
        return branchVmId;
      }
    }

    return null;
  } catch (error) {
    // VM doesn't exist or error checking - that's fine, we'll create one
    console.log(`No existing VM found for branch ${branch}: ${error.message}`);
    return null;
  }
}

/**
 * Legacy branch-scoped name helper, retained for older tooling/tests.
 * Managed workflow-job provisioning uses provisioning-state.identity instead.
 */
function generateBranchVMId(owner, repo, branch) {
  const identity = JSON.stringify([owner, repo, branch || "main"]);
  const safeOwner = String(owner || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-");
  const safeRepo = String(repo || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-");

  // Create a deterministic, DNS-safe VM name for branch-scoped VMs
  const safeBranch = String(branch || "main")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-") // Replace invalid chars with hyphens
    .replace(/-+/g, "-") // Collapse multiple hyphens
    .replace(/^-|-$/g, "") // Remove leading/trailing hyphens
    .substring(0, 20); // Limit length

  const prefix = `runner-${safeOwner}-${safeRepo}-${safeBranch}`.slice(0, 46).replace(/-+$/, "");
  return `${prefix}-${crypto.createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
}

/**
 * Create a new VM instance for runners using configurable instance template
 *
 * The shared Python provisioner loads the template metadata and merges repository
 * and job identity before creation, so the complete metadata is present at boot.
 *
 * The instance template already includes:
 * - startup-script (multi-user runner setup)
 * - shutdown-script (cleanup logic)
 * - runner-count (number of runners per VM)
 * - docker-runner-image (for Docker-based runners)
 *
 * We only add:
 * - repo-owner: GitHub repository owner
 * - repo-name: GitHub repository name
 * - vm-id: Unique VM identifier for tracking
 * - branch: Branch name for this VM
 *
 * The startup script retrieves the GitHub token from Secret Manager.
 */
async function createVMInstance(owner, repo, branch = null, allocation = null, token = null, event = null) {
  if (!event || !allocation || !token) throw new Error("Durable reservation required");
  const script = fs.readFileSync(`${__dirname}/provision-runner.py`, "utf8");
  const build = {
    serviceAccount: `projects/${PROJECT_ID}/serviceAccounts/${process.env.CLOUDBUILD_SERVICE_ACCOUNT}`,
    tags: [`runner-allocation-${allocation.key}`, `runner-reservation-${token}`],
    steps: [{
      name: "PARITY_INPUT_231:latest",
      entrypoint: "bash",
      env: [
        `ACTION=queued`, `REPO_OWNER=${owner}`, `REPO_NAME=${repo}`,
        `ALLOWED_OWNER=${process.env.GITHUB_REPO_OWNER}`, `ALLOWED_REPO=${process.env.GITHUB_REPO_NAME}`,
        `RUN_ID=${event.run_id}`, `JOB_ID=${event.job_id}`, `RUN_ATTEMPT=${event.run_attempt || "1"}`,
        `JOB_LABELS=${JSON.stringify(event.labels)}`, `REQUIRED_LABELS=${JSON.stringify(requiredLabels())}`,
        `PROJECT_ID=${PROJECT_ID}`, `ZONE=${DEFAULT_ZONE}`, `INSTANCE_TEMPLATE=${INSTANCE_TEMPLATE_NAME}`,
        `MAX_RUNNER_VMS=${MAX_RUNNER_VMS}`, `RESERVATION_TOKEN=${token}`, "BUILD_ID=$BUILD_ID",
      ],
      args: ["-c", "python3 - <<'RUNNER_PROVISIONER'\n" + script + "\nRUNNER_PROVISIONER"],
    }],
    timeout: { seconds: 600 },
    options: { logging: "CLOUD_LOGGING_ONLY" },
  };
  const [operation] = await cloudBuild.createBuild({ projectId: PROJECT_ID, build });
  return operation;
}

function requiredLabels() {
  const text = process.env.REQUIRED_RUNNER_LABELS_B64 ? Buffer.from(process.env.REQUIRED_RUNNER_LABELS_B64, "base64").toString("utf8") : process.env.REQUIRED_RUNNER_LABELS || '["self-hosted"]';
  const labels = JSON.parse(text);
  if (!Array.isArray(labels) || !labels.includes("self-hosted") || !labels.every(v => typeof v === "string" && v)) throw new Error("Invalid required labels");
  return labels;
}
function eligible(event) {
  if (!process.env.GITHUB_REPO_OWNER || !process.env.GITHUB_REPO_NAME || !process.env.CLOUDBUILD_SERVICE_ACCOUNT) throw new Error("Missing managed provisioning configuration");
  return String(event.repo_owner).toLowerCase() === process.env.GITHUB_REPO_OWNER.toLowerCase() &&
    String(event.repo_name).toLowerCase() === process.env.GITHUB_REPO_NAME.toLowerCase() &&
    requiredLabels().every(label => event.labels.includes(label));
}
const provisioning = coordinator({ firestore, cloudBuild, compute: computeClient,
  project: PROJECT_ID, zone: DEFAULT_ZONE, limit: MAX_RUNNER_VMS,
  createBuild: (event, allocation, token) => createVMInstance(event.repo_owner, event.repo_name, event.head_branch, allocation, token, event),
});

/**
 * Make scaling decision based on state metrics
 */
function makeScalingDecision(state) {
  // Handle both old and new formats for backward compatibility
  let metrics = state.metrics || state;

  if (
    !metrics ||
    (state.metrics === undefined &&
      !state.totalRunners &&
      state.totalRunners !== 0)
  ) {
    console.warn("No metrics available for VM calculation");
    return {
      scaleUp: false,
      scaleDown: false,
      vmCount: 0,
      reasons: [],
    };
  }

  // For test compatibility: if we have direct properties, create metrics object
  if (state.totalRunners !== undefined) {
    const totalRunners = state.totalRunners;
    const idleRunners = state.idleRunners || 0;
    const utilization = state.utilization / 100; // Convert percentage to decimal

    const needScaleUp = idleRunners === 0 && totalRunners < 2; // Max 2 VMs
    const needScaleDown =
      utilization < 0.3 && totalRunners > 1 && idleRunners > 1;

    metrics = {
      needScaleUp,
      needScaleDown,
      canScaleUp: totalRunners < 2,
      reasons: {
        scaleUp: needScaleUp ? ["Need more capacity"] : [],
        scaleDown: needScaleDown ? ["Too many idle runners"] : [],
      },
    };
  }

  console.log("=== VM Scaling Decision ===");
  console.log(`Scale Up Needed: ${metrics.needScaleUp}`);
  console.log(`Scale Down Needed: ${metrics.needScaleDown}`);
  console.log(`Can Scale Up: ${metrics.canScaleUp}`);

  if (metrics.needScaleUp && metrics.canScaleUp) {
    console.log("Decision: Creating 1 new VM");
    console.log("Reasons:", metrics.reasons?.scaleUp);
    return {
      scaleUp: true,
      scaleDown: false,
      vmCount: 1,
      reasons: metrics.reasons?.scaleUp || ["Need more capacity"],
    };
  } else if (metrics.needScaleDown) {
    console.log("Decision: Scaling down (handled by cleanup function)");
    console.log("Reasons:", metrics.reasons?.scaleDown);
    return {
      scaleUp: false,
      scaleDown: true,
      vmCount: 0,
      reasons: metrics.reasons?.scaleDown || ["Too many idle runners"],
    };
  } else {
    console.log("Decision: No scaling needed");
    return {
      scaleUp: false,
      scaleDown: false,
      vmCount: 0,
      reasons: [],
    };
  }
}

/**
 * Calculate required number of new VMs based on metrics
 */
function calculateRequiredVMs(state) {
  if (!state.metrics) {
    console.warn("No metrics available for VM calculation");
    return 0;
  }

  const decision = makeScalingDecision(state);
  return decision.vmCount;
}

/**
 * Process workflow_job events for autoscaling
 */
async function processWorkflowJobEvent(eventData) {
  if (eventData.action === "queued") return provisioning.provision(eventData);
  if (["completed", "cancelled"].includes(eventData.action)) await provisioning.complete(eventData);
  return "completed";
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
    // Only POST is allowed for webhook calls
    if (req.method !== "POST") {
      return res.status(405).send("Method Not Allowed");
    }

    // Authenticate the exact received bytes before parsing or any state changes.
    const signature = req.headers["x-hub-signature-256"];

    // Use the raw body for signature verification
    let payload;
    if (!Buffer.isBuffer(req.rawBody)) return res.status(400).send("Raw body required");
    payload = req.rawBody;

    const event = req.headers["x-github-event"];

    // Only require delivery header for workflow_job events
    const deliveryId = req.headers["x-github-delivery"];
    if (event === "workflow_job" && !deliveryId) {
      return res.status(400).send("Missing x-github-delivery header.");
    }

    const webhookSecret = await getWebhookSecret();
    if (typeof webhookSecret !== "string" || !webhookSecret.trim() || webhookSecret.startsWith("placeholder-")) throw new Error("Webhook secret must be explicitly configured");
    if (!verifySignature(payload, signature, webhookSecret)) return res.status(401).send("Unauthorized");
    let eventData;
    try { eventData = JSON.parse(payload.toString("utf8")); }
    catch { return res.status(400).send("Invalid JSON"); }

    // Enhanced logging with trigger source information
    const triggerInfo = {
      event_type: event,
      action: eventData.action,
      repository: `${eventData.repository?.owner?.login}/${eventData.repository?.name}`,
      branch:
        eventData.workflow_job?.head_branch ||
        eventData.workflow_run?.head_branch ||
        "unknown",
      workflow_name:
        eventData.workflow_job?.workflow_name || eventData.workflow_run?.name,
      trigger_source:
        eventData.workflow_run?.triggering_actor?.login ||
        eventData.sender?.login,
      trigger_event: eventData.workflow_run?.event || "unknown",
      run_id: eventData.workflow_job?.run_id || eventData.workflow_run?.id,
      job_id: eventData.workflow_job?.id,
    };

    console.log(`Received GitHub webhook: ${event}`, triggerInfo);

    // Process different types of events
    if (event === "workflow_job") {
      const action = eventData.action;
      const eventId =
        deliveryId ||
        `${event}-${action || "unknown"}-${
          eventData.repository?.id || "no-repo"
        }-${Date.now()}`;

      // Job state, not an untrusted delivery header, owns provisioning and
      // completion deduplication. Different actions must reach that boundary.
      const processedEventData = {
        action: action,
        job_id: eventData.workflow_job?.id,
        run_id: eventData.workflow_job?.run_id,
        run_attempt: eventData.workflow_job?.run_attempt || "1",
        repo_owner: eventData.repository?.owner?.login,
        repo_name: eventData.repository?.name,
        runner_name: eventData.workflow_job?.runner_name,
        labels: eventData.workflow_job?.labels || [],
        head_branch: eventData.workflow_job?.head_branch || "main",
        workflow_name: eventData.workflow_job?.workflow_name,
        trigger_actor: eventData.sender?.login,
        trigger_event: eventData.workflow_job?.head_sha ? "push" : "unknown",
      };

      if (
        eligible(processedEventData) &&
        processedEventData.action
      ) {
        const state = await processWorkflowJobEvent(processedEventData);
        if (state === "capacity") return res.status(503).send("Capacity unavailable; retry delivery");
        if (["submitting", "unknown"].includes(state)) return res.status(503).send("Provisioning outcome awaiting reconciliation");
        if (state === "pending") return res.status(202).send("Provisioning pending");
        await markEventProcessed(eventId, processedEventData);

        if (action === "queued") {
          return res.status(200).send("Already provisioned");
        }
        if (action === "completed" || action === "cancelled") {
          return res.status(200).send("cleanup triggered");
        }
        return res.status(200).send("Event processed");
      } else {
        console.log("Skipping event - not for self-hosted runners");
        return res.status(200).send("Not a self-hosted job");
      }
    } else if (event === "workflow_run") {
      // Create a unique event ID for idempotency
      const eventId =
        deliveryId ||
        `${event}-${eventData.action || "unknown"}-${
          eventData.repository?.id || "no-repo"
        }-${Date.now()}`;

      if (await isEventProcessed(eventId)) {
        console.log(`Event ${eventId} already processed, skipping`);
        return res.status(200).send("Event already processed");
      }

      const processedEventData = {
        action: eventData.action,
        run_id: eventData.workflow_run?.id,
        repo_owner: eventData.repository?.owner?.login,
        repo_name: eventData.repository?.name,
        conclusion: eventData.workflow_run?.conclusion,
      };

      if (processedEventData.action) {
        await processWorkflowRunEvent(processedEventData);
        await markEventProcessed(eventId, processedEventData);

        return res.status(200).send("cleanup triggered");
      } else {
        console.log(`Workflow run without action - no processing required`);
        return res.status(200).send("Event received but no action required");
      }
    } else if (event === "repository" && eventData.action === "create_runner") {
      // Manual trigger path for tests
      return res.status(200).send("Manual VM creation triggered");
    } else {
      console.log(`Unhandled event type: ${event}`);
      return res.status(200).send("Event received but no action required");
    }
  } catch (error) {
    console.error("Error processing webhook:", error);
    return res.status(500).send("Internal Server Error");
  }
}

// Register the webhook handler HTTP function
functions.http("webhookHandler", webhookHandler);

// Export functions for testing
module.exports = {
  webhookHandler,
  verifySignature,
  createVMInstance,
  findBranchVMWithCapacity,
  generateBranchVMId,
  acquireVMCreationLock,
  releaseVMCreationLock,
  isEventProcessed,
  markEventProcessed,
  getCurrentState,
  processWorkflowJobEvent,
  processWorkflowRunEvent,
  calculateRequiredVMs,
  makeScalingDecision,
  getGitHubToken,
  generateRunnerToken,
  createGitHubClient,
  getIdleRunnersCount,
};
