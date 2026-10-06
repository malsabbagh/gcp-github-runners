const functions = require("@google-cloud/functions-framework");

// Mock all dependencies
jest.mock("@google-cloud/firestore", () => ({
  Firestore: jest.fn(() => ({
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({
        get: jest.fn(() => Promise.resolve({ exists: false })),
        set: jest.fn(() => Promise.resolve()),
        update: jest.fn(() => Promise.resolve()),
        delete: jest.fn(() => Promise.resolve()),
      })),
    })),
  })),
}));

jest.mock("@google-cloud/secret-manager", () => ({
  SecretManagerServiceClient: jest.fn(() => ({
    accessSecretVersion: jest
      .fn()
      .mockResolvedValue([
        { payload: { data: { toString: () => "test-token" } } },
      ]),
  })),
}));

jest.mock("@google-cloud/cloudbuild", () => ({
  CloudBuildClient: jest.fn(() => ({
    createBuild: jest.fn(() =>
      Promise.resolve([{ name: "build-operation-123" }])
    ),
  })),
}));

jest.mock("@google-cloud/compute", () => ({
  InstancesClient: jest.fn(() => ({})),
}));

jest.mock("@octokit/rest", () => ({
  Octokit: jest.fn(() => ({
    rest: {
      actions: {
        createRegistrationTokenForRepo: jest.fn(() =>
          Promise.resolve({
            data: { token: "test-registration-token" },
          })
        ),
        listSelfHostedRunnersForRepo: jest.fn(() =>
          Promise.resolve({
            data: {
              total_count: 2,
              runners: [
                { id: 1, name: "runner-1", status: "online", busy: false },
                { id: 2, name: "runner-2", status: "online", busy: true },
              ],
            },
          })
        ),
      },
    },
  })),
}));

// Set environment variables
process.env.PROJECT_ID = "PARITY_INPUT_168";
process.env.DEFAULT_ZONE = "us-central1-a";
process.env.MAX_RUNNER_VMS = "2";

// Import the module after mocking
const {
  webhookHandler,
  verifySignature,
  calculateRequiredVMs,
  isEventProcessed,
  markEventProcessed,
  getCurrentState,
  getGitHubToken,
  generateRunnerToken,
  createVMInstance,
  findBranchVMWithCapacity,
  generateBranchVMId,
  processWorkflowJobEvent,
  createGitHubClient,
} = require("./index");

describe("Webhook Handler - Simple Tests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("Basic Function Tests", () => {
    test("webhookHandler should be defined", () => {
      expect(webhookHandler).toBeDefined();
      expect(typeof webhookHandler).toBe("function");
    });

    test("verifySignature should verify valid signatures", () => {
      const payload = "test payload";
      const secret = "test-secret";
      const crypto = require("crypto");
      const expectedSignature =
        "sha256=" +
        crypto.createHmac("sha256", secret).update(payload).digest("hex");

      const result = verifySignature(payload, expectedSignature, secret);
      expect(result).toBe(true);
    });

    test("verifySignature should reject invalid signatures", () => {
      const payload = "test payload";
      const secret = "test-secret";
      const invalidSignature = "sha256=invalid";

      const result = verifySignature(payload, invalidSignature, secret);
      expect(result).toBe(false);
    });

    test("generateBranchVMId should generate correct VM IDs", () => {
      const vmId = generateBranchVMId("test-owner", "test-repo", "main");
      expect(vmId).toBe("runner-test-owner-test-repo-main");
    });

    test("calculateRequiredVMs should calculate based on metrics", () => {
      const state = {
        metrics: {
          needScaleUp: true,
          canScaleUp: true,
          totalRunners: 0,
          reasons: {
            scaleUp: ["Need more capacity"],
          },
        },
      };

      const result = calculateRequiredVMs(state);
      expect(result).toBe(1);
    });

    test("calculateRequiredVMs should return 0 when no metrics", () => {
      const state = {};
      const result = calculateRequiredVMs(state);
      expect(result).toBe(0);
    });
  });

  describe("Async Function Tests", () => {
    test("getGitHubToken should return token", async () => {
      const token = await getGitHubToken();
      expect(token).toBe("test-token");
    });

    test("generateRunnerToken should return registration token", async () => {
      const token = await generateRunnerToken("test-owner", "test-repo");
      expect(token).toBe("test-registration-token");
    });

    test("isEventProcessed should return false for new events", async () => {
      const result = await isEventProcessed("new-event-id");
      expect(result).toBe(false);
    });

    test("getCurrentState should return state with metrics", async () => {
      const state = await getCurrentState("test-owner", "test-repo");
      expect(state).toBeDefined();
      expect(state.metrics).toBeDefined();
      expect(state.totalRunners).toBeDefined();
    });
  });

  describe("Webhook Processing", () => {
    test("should handle POST requests", async () => {
      const req = {
        method: "POST",
        headers: {
          "x-github-event": "workflow_job",
          "x-github-delivery": "test-delivery-id",
        },
        body: {
          action: "queued",
          workflow_job: {
            id: 123,
            run_id: 456,
            labels: ["self-hosted"],
            head_branch: "main",
          },
          repository: {
            name: "test-repo",
            owner: { login: "test-owner" },
          },
        },
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        send: jest.fn(),
        json: jest.fn(),
      };

      await webhookHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
    });

    test("should reject non-POST requests", async () => {
      const req = {
        method: "GET",
        headers: {},
        body: {},
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      await webhookHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(405);
      expect(res.send).toHaveBeenCalledWith("Method Not Allowed");
    });

    test("should handle missing delivery header", async () => {
      const req = {
        method: "POST",
        headers: {
          "x-github-event": "workflow_job",
        },
        body: {},
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      await webhookHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.send).toHaveBeenCalledWith(
        "Missing x-github-delivery header."
      );
    });

    test("should handle non-self-hosted jobs", async () => {
      const req = {
        method: "POST",
        headers: {
          "x-github-event": "workflow_job",
          "x-github-delivery": "test-delivery-id",
        },
        body: {
          action: "queued",
          workflow_job: {
            id: 123,
            run_id: 456,
            labels: ["ubuntu-latest"], // Not self-hosted
            head_branch: "main",
          },
          repository: {
            name: "test-repo",
            owner: { login: "test-owner" },
          },
        },
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      await webhookHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalledWith("Not a self-hosted job");
    });
  });

  describe("Error Handling", () => {
    test("should handle internal errors gracefully", async () => {
      const req = {
        method: "POST",
        headers: {
          "x-github-event": "workflow_job",
          "x-github-delivery": "test-delivery-id",
        },
        body: {
          action: "queued",
          workflow_job: {
            id: 123,
            run_id: 456,
            labels: ["self-hosted"],
            head_branch: "main",
          },
          repository: {
            name: "test-repo",
            owner: { login: "test-owner" },
          },
        },
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      // Mock an error in the processing
      const mockIsEventProcessed = require("./index").isEventProcessed;
      mockIsEventProcessed.mockRejectedValueOnce(new Error("Test error"));

      await webhookHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.send).toHaveBeenCalledWith("Internal server error");
    });
  });
});
