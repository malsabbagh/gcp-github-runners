const { CloudBuildClient } = require("@google-cloud/cloudbuild");
const { SecretManagerServiceClient } = require("@google-cloud/secret-manager");
const { Firestore } = require("@google-cloud/firestore");
const { InstancesClient } = require("@google-cloud/compute");
const functions = require("@google-cloud/functions-framework");
const crypto = require("crypto");
const fs = require("fs");
const { coordinator, identity } = require("./provisioning-state");
const { validRoutingLabels } = require("./runner-labels");
const { createActualJobAssociation } = require("./actual-job-association");
const { createAllocationRecovery } = require("./allocation-recovery");
const {
  INFRASTRUCTURE_CONFIG,
  validateConfiguration,
} = require("./infrastructure-config");

// Initialize clients
const cloudBuild = new CloudBuildClient();
const computeClient = new InstancesClient();
const secretManager = new SecretManagerServiceClient({
  projectId: INFRASTRUCTURE_CONFIG.PROJECT_ID,
});
const firestore = new Firestore({
  databaseId: INFRASTRUCTURE_CONFIG.FIRESTORE_DATABASE_ID,
});

// Validate configuration on startup
validateConfiguration();

// Configuration from infrastructure config
const PROJECT_ID = INFRASTRUCTURE_CONFIG.PROJECT_ID;
const WEBHOOK_SECRET_VERSION = INFRASTRUCTURE_CONFIG.WEBHOOK_SECRET_VERSION;
const DEFAULT_ZONE = INFRASTRUCTURE_CONFIG.DEFAULT_ZONE;
const INSTANCE_TEMPLATE_NAME = INFRASTRUCTURE_CONFIG.INSTANCE_TEMPLATE_NAME;

// Log the project ID for debugging


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
    console.error("Error checking if event is processed:");
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
    console.error("Error marking event as processed:");
    throw error;
  }
}

/**
 * Get webhook secret from Secret Manager
 */
async function getWebhookSecret() {
  try {
    const [version] = await secretManager.accessSecretVersion({
      name: WEBHOOK_SECRET_VERSION,
    });
    return version.payload.data.toString();
  } catch (error) {
    console.error("Error getting webhook secret:");
    throw error;
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
    console.error("Signature verification failed:");
    return false;
  }
}

// Management-only asynchronous provisioning; worker bootstrap is allocation-bound.
async function createVMInstance(owner, repo, branch = null, allocation = null, token = null, event = null) {
  if (!event || !allocation || !token) throw new Error("Durable reservation required");
  const script = fs.readFileSync(`${__dirname}/provision-runner.py`, "utf8");
  const build = {
    serviceAccount: `projects/${PROJECT_ID}/serviceAccounts/${process.env.CLOUDBUILD_SERVICE_ACCOUNT}`,
    tags: [`runner-allocation-${allocation.key}`, `runner-reservation-${token}`],
    steps: [{
      name: INFRASTRUCTURE_CONFIG.BUILDER_IMAGE,
      entrypoint: "bash",
      env: [
        `ACTION=queued`, `REPO_OWNER=${owner}`, `REPO_NAME=${repo}`,
        `ALLOWED_OWNER=${process.env.GITHUB_REPO_OWNER}`, `ALLOWED_REPO=${process.env.GITHUB_REPO_NAME}`,
        `RUN_ID=${event.run_id}`, `JOB_ID=${event.job_id}`, `RUN_ATTEMPT=${event.run_attempt || "1"}`,
        `JOB_LABELS=${JSON.stringify(event.labels)}`, `REQUIRED_LABELS=${JSON.stringify(requiredLabels())}`,
        `REGISTERED_LABELS=${JSON.stringify(registeredLabels())}`, `RUNNER_ROUTING_LABEL=${process.env.RUNNER_ROUTING_LABEL}`,
        `PROJECT_ID=${PROJECT_ID}`, `ZONE=${DEFAULT_ZONE}`, `INSTANCE_TEMPLATE=${INSTANCE_TEMPLATE_NAME}`,
        `FIRESTORE_DATABASE_ID=${INFRASTRUCTURE_CONFIG.FIRESTORE_DATABASE_ID}`,
        `MAX_RUNNER_VMS=${MAX_RUNNER_VMS}`, `RESERVATION_TOKEN=${token}`, "BUILD_ID=$BUILD_ID",
        `WORKER_SERVICE_ACCOUNT=${INFRASTRUCTURE_CONFIG.WORKER_SERVICE_ACCOUNT}`,
        `WORKER_SERVICE_ACCOUNT_UNIQUE_ID=${INFRASTRUCTURE_CONFIG.WORKER_SERVICE_ACCOUNT_UNIQUE_ID}`,
        `ALLOCATION_BROKER_URL=${INFRASTRUCTURE_CONFIG.ALLOCATION_BROKER_URL}`,
        `BOOTSTRAP_TTL_MS=${INFRASTRUCTURE_CONFIG.BOOTSTRAP_TTL_MS}`,
        `RECONCILIATION_BATCH_SIZE=${INFRASTRUCTURE_CONFIG.RECONCILIATION_BATCH_SIZE}`,
      ],
      args: ["-c", "python3 - <<'RUNNER_PROVISIONER'\n" + script + "\nRUNNER_PROVISIONER"],
    }],
    timeout: { seconds: INFRASTRUCTURE_CONFIG.VM_CREATION_TIMEOUT_SECONDS },
    options: { logging: "CLOUD_LOGGING_ONLY" },
  };
  const [operation] = await cloudBuild.createBuild({ projectId: PROJECT_ID, build });
  return operation;
}

function registeredLabels() {
  const labels = JSON.parse(process.env.RUNNER_LABELS_JSON || "null");
  const routing = process.env.RUNNER_ROUTING_LABEL;
  if (!validRoutingLabels(labels, routing)) {
    throw new Error("Dedicated registered runner labels required");
  }
  return labels;
}
function requiredLabels() {
  const text = process.env.REQUIRED_RUNNER_LABELS_B64 ? Buffer.from(process.env.REQUIRED_RUNNER_LABELS_B64, "base64").toString("utf8") : process.env.REQUIRED_RUNNER_LABELS;
  const labels = JSON.parse(text || "null");
  const registered = registeredLabels();
  if (!Array.isArray(labels) || !labels.includes("self-hosted") || !labels.includes(process.env.RUNNER_ROUTING_LABEL) ||
      !labels.every(v => registered.includes(v))) throw new Error("Invalid required labels");
  return labels;
}
function eligible(event) {
  if (!process.env.GITHUB_REPO_OWNER || !process.env.GITHUB_REPO_NAME || !process.env.CLOUDBUILD_SERVICE_ACCOUNT) throw new Error("Missing managed provisioning configuration");
  const registered = registeredLabels();
  return String(event.repo_owner).toLowerCase() === process.env.GITHUB_REPO_OWNER.toLowerCase() &&
    String(event.repo_name).toLowerCase() === process.env.GITHUB_REPO_NAME.toLowerCase() &&
    Array.isArray(event.labels) && event.labels.every(label => registered.includes(label)) &&
    requiredLabels().every(label => event.labels.includes(label));
}
const actualAssociations = createActualJobAssociation({ firestore,
  repositoryOwner: process.env.GITHUB_REPO_OWNER, repositoryName: process.env.GITHUB_REPO_NAME });
const recovery = createAllocationRecovery({ firestore, compute: computeClient, cloudBuild,
  project: PROJECT_ID, zone: DEFAULT_ZONE,
  repositoryOwner: process.env.GITHUB_REPO_OWNER, repositoryName: process.env.GITHUB_REPO_NAME,
  workerServiceAccountEmail: INFRASTRUCTURE_CONFIG.WORKER_SERVICE_ACCOUNT,
  workerServiceAccountUniqueId: INFRASTRUCTURE_CONFIG.WORKER_SERVICE_ACCOUNT_UNIQUE_ID,
  brokerUrl: INFRASTRUCTURE_CONFIG.ALLOCATION_BROKER_URL,
  bootstrapTTLms: INFRASTRUCTURE_CONFIG.BOOTSTRAP_TTL_MS,
  registeredLabels: registeredLabels(), routingLabel: process.env.RUNNER_ROUTING_LABEL });
const provisioning = coordinator({ firestore, cloudBuild, compute: computeClient, recovery,
  project: PROJECT_ID, zone: DEFAULT_ZONE, limit: MAX_RUNNER_VMS,
  workerServiceAccountEmail: INFRASTRUCTURE_CONFIG.WORKER_SERVICE_ACCOUNT,
  workerServiceAccountUniqueId: INFRASTRUCTURE_CONFIG.WORKER_SERVICE_ACCOUNT_UNIQUE_ID,
  brokerUrl: INFRASTRUCTURE_CONFIG.ALLOCATION_BROKER_URL,
  bootstrapTTLms: INFRASTRUCTURE_CONFIG.BOOTSTRAP_TTL_MS,
  recoveryBatchSize: INFRASTRUCTURE_CONFIG.RECONCILIATION_BATCH_SIZE,
  createBuild: (event, allocation, token) => createVMInstance(event.repo_owner, event.repo_name, event.head_branch, allocation, token, event),
});

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
    console.log("Workflow run received");

    if (eventData.action === "completed") {
      console.log("Workflow run completion received");
    }
  } catch (error) {
    console.error("Error processing workflow_run event:");
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
    if (req.rawBody.length > 262144) return res.status(413).send("Payload too large");
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

    // Only the configured repository may create demand or completion records.
    if (String(eventData.repository?.owner?.login).toLowerCase() !== process.env.GITHUB_REPO_OWNER.toLowerCase() ||
        String(eventData.repository?.name).toLowerCase() !== process.env.GITHUB_REPO_NAME.toLowerCase()) {
      return res.status(200).send("Repository outside configured scope");
    }

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
        runner_id: eventData.workflow_job?.runner_id,
        verifiedWebhook: true,
        labels: eventData.workflow_job?.labels || [],
        head_branch: eventData.workflow_job?.head_branch || "main",
        workflow_name: eventData.workflow_job?.workflow_name,
        trigger_actor: eventData.sender?.login,
        trigger_event: eventData.workflow_job?.head_sha ? "push" : "unknown",
      };

      // Actual dispatch can differ from reserved demand and routing labels.
      // Authentication/repository checks above own admission; the observer then
      // requires the exact already-issued runner/claim/incarnation before writes.
      if (["in_progress", "completed"].includes(action)) {
        const observed = await actualAssociations.observe(processedEventData);
        if (observed.reason === 'association_state_unavailable')
          return res.status(503).send('Actual job observation requires retry');
      }

      if (
        eligible(processedEventData) &&
        processedEventData.action
      ) {
        const state = await processWorkflowJobEvent(processedEventData);
        if (state === "capacity") return res.status(503).send("Capacity unavailable; durable demand awaits scheduler");
        if (["submitting", "unknown"].includes(state)) return res.status(503).send("Provisioning outcome awaiting reconciliation");
        if (state === "pending") return res.status(202).send("Provisioning pending");
        await markEventProcessed(eventId, processedEventData);

        if (action === "queued") {
          return res.status(200).send("Already provisioned");
        }
        if (action === "completed" || action === "cancelled") {
          return res.status(200).send("Completion recorded");
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
        console.log("Event already processed");
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
    } else {
      console.log("Unhandled event type");
      return res.status(200).send("Event received but no action required");
    }
  } catch (error) {
    console.error("Error processing webhook:");
    return res.status(500).send("Internal Server Error");
  }
}

// Register the webhook handler HTTP function
functions.http("webhookHandler", webhookHandler);

// Management-only canonical exports; legacy shared-host entry points omitted.
// This callable preparation factory shares the webhook controller clients.
// It registers no additional endpoint and makes no provider call at creation.
function prepareControllerProfile({ transportGuard = () => false,
  jitProviderLifetimeQualified = false, approvedQuiescence = false } = {}) {
  const { createControllerProfile } = require('./controller-profile');
  return createControllerProfile({ infrastructureConfig: INFRASTRUCTURE_CONFIG,
    firestore, compute: computeClient, cloudBuild, environment: process.env,
    registeredLabels: registeredLabels(), transportGuard,
    jitProviderLifetimeQualified, approvedQuiescence });
}
module.exports = {
  webhookHandler, verifySignature, createVMInstance, isEventProcessed,
  markEventProcessed, processWorkflowJobEvent, processWorkflowRunEvent,
  prepareControllerProfile,
};
