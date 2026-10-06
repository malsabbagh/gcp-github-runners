const fs = require("node:fs");
const path = require("node:path");
const { CloudBuildClient } = require("@google-cloud/cloudbuild");
const functions = require("@google-cloud/functions-framework");

// Initialize Cloud Build client
const cloudBuild = new CloudBuildClient();

// Configuration from environment variables
const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT;
// Age-based selection is bounded to one year to avoid datetime overflow.
const MAX_AGE_HOURS = 8760;
const DEFAULT_ZONE = process.env.DEFAULT_ZONE || "us-central1-a";
// Load the required bundle member once. A missing artifact fails at module load
// rather than after accepting a cleanup invocation.
const CLEANUP_SCRIPT = fs.readFileSync(path.join(__dirname, "runner-cleanup.sh"), "utf8").replace(/\$/g, "$$$$");

/**
 * Cleanup old runner instances
 */
async function cleanupOldRunners(maxAgeHours = 2) {
  if (!Number.isSafeInteger(maxAgeHours) || maxAgeHours < 0 || maxAgeHours > MAX_AGE_HOURS) {
    throw new TypeError("maxAge must be an integer between 0 and 8760 hours");
  }
  const buildConfig = {
    steps: [
      {
        name: "PARITY_INPUT_231:latest",
        entrypoint: "bash",
        args: [
          "-c",
          // Cloud Build treats dollars as substitutions; escape script literals.
          `echo "Cleaning up runner instances older than ${maxAgeHours} hours..."
` +
          `export MAX_AGE_HOURS=${maxAgeHours}
` +
          CLEANUP_SCRIPT,
        ],
      },
    ],
    options: {
      logging: "CLOUD_LOGGING_ONLY",
    },
    timeout: "600s",
  };

  const [operation] = await cloudBuild.createBuild({
    projectId: PROJECT_ID,
    build: buildConfig,
  });

  console.log(`Triggered cleanup build: ${operation.name}`);
  return operation;
}

/**
 * Scheduled cleanup function
 */
functions.cloudEvent("scheduledCleanup", async (cloudEvent) => {
  console.log("Starting scheduled cleanup of old runner instances");

  try {
    await cleanupOldRunners(2); // Cleanup instances older than 2 hours
    console.log("Scheduled cleanup completed successfully");
  } catch (error) {
    console.error("Error during scheduled cleanup:", error);
    throw error;
  }
});

/**
 * HTTP-triggered cleanup function for manual use
 */
functions.http("cleanupRunners", async (req, res) => {
  try {
    const maxAgeParam = req.query.maxAge;
    let maxAgeHours = 2; // Default value

    if (maxAgeParam) {
      const parsedAge = /^\d+$/.test(String(maxAgeParam)) ? Number(maxAgeParam) : NaN;
      if (!Number.isSafeInteger(parsedAge) || parsedAge < 0 || parsedAge > MAX_AGE_HOURS) {
        res
          .status(400)
          .send(
            'Invalid "maxAge" parameter. It must be an integer between 0 and 8760 hours.'
          );
        return;
      }
      maxAgeHours = parsedAge;
    }

    console.log(
      `Manual cleanup triggered for instances older than ${maxAgeHours} hours`
    );

    await cleanupOldRunners(maxAgeHours);

    res
      .status(200)
      .send(`Cleanup triggered for instances older than ${maxAgeHours} hours`);
  } catch (error) {
    console.error("Error in manual cleanup:", error);
    res.status(500).send("Internal Server Error");
  }
});

// Export functions for testing
module.exports = {
  cleanupOldRunners
};
