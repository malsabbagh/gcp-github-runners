const { CloudBuildClient } = require("@google-cloud/cloudbuild");
const { SecretManagerServiceClient } = require("@google-cloud/secret-manager");
const { Firestore } = require("@google-cloud/firestore");
const { InstancesClient } = require("@google-cloud/compute");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { coordinator, identity, BuildNotSubmitted } = require("./provisioning-state");
const { validRoutingLabels } = require("./runner-labels");
const { createActualJobAssociation } = require("./actual-job-association");
const { createAllocationRecovery } = require("./allocation-recovery");
const { readInfrastructureConfiguration, validateConfiguration } = require("./infrastructure-config");
const { readBootstrapConfiguration } = require("./bootstrap-runtime");
const { createGitHubAppRunnerAdapter, createSecretManagerPrivateKeyProvider } = require("./github-app-runner-adapter");


function createWebhookRuntime({environment = process.env, infrastructureConfig, clients = {}} = {}) {
const INFRASTRUCTURE_CONFIG = infrastructureConfig || readInfrastructureConfiguration(environment);
// Initialize clients
const cloudBuild = clients.cloudBuild || new CloudBuildClient();
const computeClient = clients.compute || new InstancesClient();
const secretManager = clients.secretManager || new SecretManagerServiceClient({
  projectId: INFRASTRUCTURE_CONFIG.PROJECT_ID,
});
const firestore = clients.firestore || new Firestore({
  databaseId: INFRASTRUCTURE_CONFIG.FIRESTORE_DATABASE_ID,
});

// Validate configuration on startup
validateConfiguration(environment, INFRASTRUCTURE_CONFIG);

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
  try {
    if (!await authorizeDemand(event)) {
      const error = Error('Private repository admission denied'); error.code = 'REPOSITORY_DENIED'; throw error;
    }
  } catch (error) { throw new BuildNotSubmitted(error); }
  const script = fs.readFileSync(`${__dirname}/provision-runner.py`, "utf8");
  const build = {
    serviceAccount: `projects/${PROJECT_ID}/serviceAccounts/${environment.CLOUDBUILD_SERVICE_ACCOUNT}`,
    tags: [`runner-allocation-${allocation.key}`, `runner-reservation-${token}`],
    steps: [{
      name: INFRASTRUCTURE_CONFIG.BUILDER_IMAGE,
      entrypoint: "bash",
      env: [
        `ACTION=queued`, `REPO_OWNER=${owner}`, `REPO_NAME=${repo}`,
        `ALLOWED_OWNER=${environment.GITHUB_REPO_OWNER}`, `ALLOWED_REPO=${environment.GITHUB_REPO_NAME}`,
        `RUN_ID=${event.run_id}`, `JOB_ID=${event.job_id}`, `RUN_ATTEMPT=${event.run_attempt || "1"}`,
        `JOB_LABELS=${JSON.stringify(event.labels)}`, `REQUIRED_LABELS=${JSON.stringify(requiredLabels())}`,
        `REGISTERED_LABELS=${JSON.stringify(registeredLabels())}`, `RUNNER_ROUTING_LABEL=${environment.RUNNER_ROUTING_LABEL}`,
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
  const labels = JSON.parse(environment.RUNNER_LABELS_JSON || "null");
  const routing = environment.RUNNER_ROUTING_LABEL;
  if (!validRoutingLabels(labels, routing)) {
    throw new Error("Dedicated registered runner labels required");
  }
  return labels;
}
function requiredLabels() {
  const text = environment.REQUIRED_RUNNER_LABELS_B64 ? Buffer.from(environment.REQUIRED_RUNNER_LABELS_B64, "base64").toString("utf8") : environment.REQUIRED_RUNNER_LABELS;
  const labels = JSON.parse(text || "null");
  const registered = registeredLabels();
  if (!Array.isArray(labels) || !labels.includes("self-hosted") || !labels.includes(environment.RUNNER_ROUTING_LABEL) ||
      !labels.every(v => registered.includes(v))) throw new Error("Invalid required labels");
  return labels;
}
function eligible(event) {
  if (!environment.GITHUB_REPO_OWNER || !environment.GITHUB_REPO_NAME || !environment.CLOUDBUILD_SERVICE_ACCOUNT) throw new Error("Missing managed provisioning configuration");
  const registered = registeredLabels();
  return String(event.repo_owner).toLowerCase() === environment.GITHUB_REPO_OWNER.toLowerCase() &&
    String(event.repo_name).toLowerCase() === environment.GITHUB_REPO_NAME.toLowerCase() &&
    Array.isArray(event.labels) && event.labels.every(label => registered.includes(label)) &&
    requiredLabels().every(label => event.labels.includes(label));
}
let repositoryAdapter;
async function verifyPrivateRepository() {
  if (clients.verifyPrivateRepository) return clients.verifyPrivateRepository();
  try {
    if (!repositoryAdapter) {
      const appConfig = readBootstrapConfiguration(environment);
      if (!appConfig.privateKeyVersion.startsWith(`projects/${PROJECT_ID}/`)) throw Error('Repository configuration invalid');
      repositoryAdapter = createGitHubAppRunnerAdapter({...appConfig,
        repositoryOwner: environment.GITHUB_REPO_OWNER, repositoryName: environment.GITHUB_REPO_NAME,
        privateKeyProvider: createSecretManagerPrivateKeyProvider({secretVersion: appConfig.privateKeyVersion, secretManagerClient: secretManager})});
    }
    return (await repositoryAdapter).verifyPrivateRepository();
  } catch (_) { repositoryAdapter = undefined; throw Error('Repository verification unavailable'); }
}
async function authorizeDemand(event) {
  const repositoryId = environment.GITHUB_REPOSITORY_ID;
  if (!eligible(event) || event.verifiedWebhook !== true || event.repo_private !== true ||
      typeof repositoryId !== 'string' || !/^[1-9][0-9]{0,15}$/.test(repositoryId) ||
      !Number.isSafeInteger(Number(repositoryId)) || event.repo_id !== Number(repositoryId)) return false;
  try { return await verifyPrivateRepository() === true; }
  catch (_) { const error = Error('Repository verification unavailable'); error.code = 'REPOSITORY_UNAVAILABLE'; throw error; }
}
const actualAssociations = createActualJobAssociation({ firestore,
  repositoryOwner: environment.GITHUB_REPO_OWNER, repositoryName: environment.GITHUB_REPO_NAME });
const recovery = createAllocationRecovery({ firestore, compute: computeClient, cloudBuild,
  project: PROJECT_ID, zone: DEFAULT_ZONE,
  repositoryOwner: environment.GITHUB_REPO_OWNER, repositoryName: environment.GITHUB_REPO_NAME,
  workerServiceAccountEmail: INFRASTRUCTURE_CONFIG.WORKER_SERVICE_ACCOUNT,
  workerServiceAccountUniqueId: INFRASTRUCTURE_CONFIG.WORKER_SERVICE_ACCOUNT_UNIQUE_ID,
  brokerUrl: INFRASTRUCTURE_CONFIG.ALLOCATION_BROKER_URL,
  bootstrapTTLms: INFRASTRUCTURE_CONFIG.BOOTSTRAP_TTL_MS,
  registeredLabels: registeredLabels(), routingLabel: environment.RUNNER_ROUTING_LABEL });
const coreProvisioning = coordinator({ firestore, cloudBuild, compute: computeClient, recovery,
  project: PROJECT_ID, zone: DEFAULT_ZONE, limit: MAX_RUNNER_VMS,
  workerServiceAccountEmail: INFRASTRUCTURE_CONFIG.WORKER_SERVICE_ACCOUNT,
  workerServiceAccountUniqueId: INFRASTRUCTURE_CONFIG.WORKER_SERVICE_ACCOUNT_UNIQUE_ID,
  brokerUrl: INFRASTRUCTURE_CONFIG.ALLOCATION_BROKER_URL,
  bootstrapTTLms: INFRASTRUCTURE_CONFIG.BOOTSTRAP_TTL_MS,
  recoveryBatchSize: INFRASTRUCTURE_CONFIG.RECONCILIATION_BATCH_SIZE,
  createBuild: (event, allocation, token) => createVMInstance(event.repo_owner, event.repo_name, event.head_branch, allocation, token, event),
});

const provisioning = Object.freeze({...coreProvisioning,
  async provision(event) { return await authorizeDemand(event) ? coreProvisioning.provision(event) : 'denied'; }
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
    if (String(eventData.repository?.owner?.login).toLowerCase() !== environment.GITHUB_REPO_OWNER.toLowerCase() ||
        String(eventData.repository?.name).toLowerCase() !== environment.GITHUB_REPO_NAME.toLowerCase()) {
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
        repo_id: eventData.repository?.id,
        repo_private: eventData.repository?.private,
        runner_name: eventData.workflow_job?.runner_name,
        runner_id: eventData.workflow_job?.runner_id,
        verifiedWebhook: true,
        labels: eventData.workflow_job?.labels || [],
        head_branch: eventData.workflow_job?.head_branch || "main",
        workflow_name: eventData.workflow_job?.workflow_name,
        trigger_actor: eventData.sender?.login,
        trigger_event: "unknown",
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
        if (state === "denied") return res.status(200).send("Repository not eligible for new demand");
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
        repo_id: eventData.repository?.id,
        repo_private: eventData.repository?.private,
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
    if (error.code === 'REPOSITORY_DENIED') return res.status(200).send('Repository not eligible for new demand');
    if (error.code === 'REPOSITORY_UNAVAILABLE') return res.status(503).send('Repository verification requires retry');
    console.error("Error processing webhook:");
    return res.status(500).send("Internal Server Error");
  }
}


return {webhookHandler, verifySignature, createVMInstance, isEventProcessed, markEventProcessed, processWorkflowJobEvent, processWorkflowRunEvent, clients: {cloudBuild, compute: computeClient, secretManager, firestore}, infrastructureConfig: INFRASTRUCTURE_CONFIG, registeredLabels: registeredLabels(),provisioning,eligible,authorizeDemand};
}
module.exports = {createWebhookRuntime};
