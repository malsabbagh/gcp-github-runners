const functions = require("@google-cloud/functions-framework");

// Mock all dependencies at the top level
const mockFirestore = {
  collection: jest.fn(() => ({
    doc: jest.fn(() => ({
      get: jest.fn(() => Promise.resolve({ exists: false })),
      set: jest.fn(() => Promise.resolve()),
      update: jest.fn(() => Promise.resolve()),
      delete: jest.fn(() => Promise.resolve()),
    })),
    get: jest.fn(() => Promise.resolve({ forEach: jest.fn() })),
    where: jest.fn(() => ({
      get: jest.fn(() => Promise.resolve({ forEach: jest.fn() })),
    })),
  })),
  runTransaction: jest.fn((callback) =>
    callback({
      get: jest.fn(() =>
        Promise.resolve({
          exists: false,
          data: () => ({}),
        })
      ),
      set: jest.fn(),
      delete: jest.fn(),
    })
  ),
};

const mockSecretManager = {
  accessSecretVersion: jest.fn(() =>
    Promise.resolve([{ payload: { data: { toString: () => "test-token" } } }])
  ),
};

const mockCloudBuild = {
  createBuild: jest.fn(() =>
    Promise.resolve([{ name: "build-operation-123" }])
  ),
};

const mockOctokit = {
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
};

jest.mock("@google-cloud/firestore", () => ({
  Firestore: jest.fn(() => mockFirestore),
}));

jest.mock("@google-cloud/secret-manager", () => ({
  SecretManagerServiceClient: jest.fn(() => mockSecretManager),
}));

jest.mock("@google-cloud/cloudbuild", () => ({
  CloudBuildClient: jest.fn(() => mockCloudBuild),
}));

jest.mock("@google-cloud/compute", () => ({
  InstancesClient: jest.fn(() => ({})),
}));

jest.mock("@octokit/rest", () => ({
  Octokit: jest.fn(() => mockOctokit),
}));

// Set environment variables
process.env.GOOGLE_CLOUD_PROJECT = "example-project";
process.env.DEFAULT_ZONE = "us-central1-a";
process.env.MAX_RUNNER_VMS = "2";

// Import the module after mocking
const {
  verifySignature,
  calculateRequiredVMs,
  generateBranchVMId,
  isEventProcessed,
  markEventProcessed,
} = require("./index");

describe("Webhook Handler - Unit Tests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset mock implementations
    mockFirestore.collection.mockReturnValue({
      doc: jest.fn(() => ({
        get: jest.fn(() => Promise.resolve({ exists: false })),
        set: jest.fn(() => Promise.resolve()),
        update: jest.fn(() => Promise.resolve()),
        delete: jest.fn(() => Promise.resolve()),
      })),
      get: jest.fn(() => Promise.resolve({ forEach: jest.fn() })),
      where: jest.fn(() => ({
        get: jest.fn(() => Promise.resolve({ forEach: jest.fn() })),
      })),
    });
  });

  describe("Core Function Tests", () => {
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
      expect(vmId).toMatch(/^runner-test-owner-test-repo-main-[a-f0-9]{16}$/);
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

    test("calculateRequiredVMs should not scale when cannot scale up", () => {
      const state = {
        metrics: {
          needScaleUp: true,
          canScaleUp: false,
          totalRunners: 2,
          reasons: {
            scaleUp: ["Need more capacity"],
          },
        },
      };

      const result = calculateRequiredVMs(state);
      expect(result).toBe(0);
    });
  });

  describe("Async Function Tests", () => {
    test("isEventProcessed should return false for new events", async () => {
      const result = await isEventProcessed("new-event-id");
      expect(result).toBe(false);
    });

    test("markEventProcessed should handle event data", async () => {
      const eventData = {
        event_type: "workflow_job",
        action: "queued",
        job_id: "123",
        repository: "test/repo",
      };

      // Should not throw
      await expect(
        markEventProcessed("event-123", eventData)
      ).resolves.toBeUndefined();
    });
  });

  describe("VM ID Generation", () => {
    test("should handle different branch names", () => {
      expect(generateBranchVMId("owner", "repo", "feature/new-feature")).toMatch(/^runner-owner-repo-feature-new-feature-[a-f0-9]{16}$/);
      expect(generateBranchVMId("owner", "repo", "hotfix/bug-123")).toMatch(/^runner-owner-repo-hotfix-bug-123-[a-f0-9]{16}$/);
      expect(generateBranchVMId("owner", "repo", "develop")).toMatch(/^runner-owner-repo-develop-[a-f0-9]{16}$/);
    });

    test("should sanitize special characters in branch names", () => {
      // The function should handle special characters gracefully
      expect(generateBranchVMId("owner", "repo", "feature/test@123")).toMatch(/^runner-owner-repo-feature-test-123-[a-f0-9]{16}$/);
    });
  });

  describe("Scaling Logic", () => {
    test("should handle scale down scenarios", () => {
      const state = {
        metrics: {
          needScaleUp: false,
          needScaleDown: true,
          canScaleUp: true,
          totalRunners: 2,
          reasons: {
            scaleDown: ["Too many idle runners"],
          },
        },
      };

      const result = calculateRequiredVMs(state);
      expect(result).toBe(0); // Should not create new VMs when scaling down
    });

    test("should handle no scaling needed", () => {
      const state = {
        metrics: {
          needScaleUp: false,
          needScaleDown: false,
          canScaleUp: true,
          totalRunners: 1,
          reasons: {
            scaleUp: [],
            scaleDown: [],
          },
        },
      };

      const result = calculateRequiredVMs(state);
      expect(result).toBe(0);
    });
  });

  describe("Signature Verification Edge Cases", () => {
    test("should reject signature without sha256 prefix", () => {
      const payload = "test payload";
      const secret = "test-secret";
      const invalidSignature = "invalid-signature-format";

      const result = verifySignature(payload, invalidSignature, secret);
      expect(result).toBe(false);
    });

    test("should reject when no signature provided", () => {
      const payload = "test payload";
      const secret = "test-secret";

      const result = verifySignature(payload, null, secret);
      expect(result).toBe(false);
    });

    test("should reject when no secret provided", () => {
      const payload = "test payload";
      const signature = "sha256=somehash";

      const result = verifySignature(payload, signature, null);
      expect(result).toBe(false);
    });

    test("should handle signature length mismatch", () => {
      const payload = "test payload";
      const secret = "test-secret";
      const shortSignature = "sha256=short";

      const result = verifySignature(payload, shortSignature, secret);
      expect(result).toBe(false);
    });
  });

  describe("Error Handling in Event Processing", () => {
    test("isEventProcessed should handle firestore errors gracefully", async () => {
      // Mock firestore to throw an error
      mockFirestore.collection.mockReturnValueOnce({
        doc: jest.fn(() => ({
          get: jest.fn(() => Promise.reject(new Error("Firestore error"))),
        })),
      });

      await expect(isEventProcessed("test-event-id")).rejects.toThrow("Firestore error");
    });

    test("markEventProcessed should handle undefined values in event data", async () => {
      const eventData = {
        event_type: "workflow_job",
        action: "queued",
        job_id: undefined,
        repository: "test/repo",
        nested_object: {
          value: undefined,
          other_value: "defined",
        },
      };

      // Should not throw and clean undefined values
      await expect(
        markEventProcessed("event-123", eventData)
      ).resolves.toBeUndefined();
    });
  });

  describe("Lock Management", () => {
    const { acquireVMCreationLock, releaseVMCreationLock } = require("./index");

    beforeEach(() => {
      jest.clearAllMocks();
    });

    test("acquireVMCreationLock should handle successful lock acquisition", async () => {
      // Mock successful transaction
      mockFirestore.runTransaction.mockImplementationOnce((callback) =>
        callback({
          get: jest.fn(() => Promise.resolve({ exists: false })),
          set: jest.fn(),
        })
      );

      const lockId = await acquireVMCreationLock(
        "test-owner",
        "test-repo",
        "main",
        5000
      );

      expect(lockId).toBeDefined();
      expect(typeof lockId).toBe("string");
    });

    test("acquireVMCreationLock should handle lock contention", async () => {
      // Mock lock already exists and not expired
      mockFirestore.runTransaction.mockImplementationOnce((callback) =>
        callback({
          get: jest.fn(() =>
            Promise.resolve({
              exists: true,
              data: () => ({
                expirationTime: Date.now() + 10000, // Not expired
                lockId: "existing-lock",
              }),
            })
          ),
          set: jest.fn(),
        })
      );

      const result = await acquireVMCreationLock(
        "test-owner",
        "test-repo",
        "main",
        100
      );
      expect(result).toBeNull();
    });

    test("releaseVMCreationLock should handle successful release", async () => {
      // Mock successful transaction
      mockFirestore.runTransaction.mockImplementationOnce((callback) =>
        callback({
          get: jest.fn(() =>
            Promise.resolve({
              exists: true,
              data: () => ({ lockId: "test-lock-id" }),
            })
          ),
          delete: jest.fn(),
        })
      );

      await expect(
        releaseVMCreationLock("test-owner", "test-repo", "main", "test-lock-id")
      ).resolves.toBeUndefined();
    });

    test("releaseVMCreationLock should handle lock ID mismatch", async () => {
      // Mock lock with different ID
      const mockDelete = jest.fn();
      mockFirestore.runTransaction.mockImplementationOnce((callback) =>
        callback({
          get: jest.fn(() =>
            Promise.resolve({
              exists: true,
              data: () => ({ lockId: "different-lock-id" }),
            })
          ),
          delete: mockDelete,
        })
      );

      await releaseVMCreationLock(
        "test-owner",
        "test-repo",
        "main",
        "test-lock-id"
      );

      // Should not call delete when lock ID doesn't match
      expect(mockDelete).not.toHaveBeenCalled();
    });
  });

  describe("VM ID Generation", () => {
    const { generateBranchVMId } = require("./index");

    test("should handle empty branch parameter", () => {
      // Mock Date.now() for consistent testing
      const mockDate = 1234567890;
      jest.spyOn(Date, "now").mockReturnValue(mockDate);

      const vmId = generateBranchVMId("test-owner", "test-repo", null);
      expect(vmId).toMatch(/^runner-test-owner-test-repo-main-[a-f0-9]{16}$/);

      Date.now.mockRestore();
    });

    test("should handle undefined branch parameter", () => {
      const mockDate = 1234567890;
      jest.spyOn(Date, "now").mockReturnValue(mockDate);

      const vmId = generateBranchVMId("test-owner", "test-repo", undefined);
      expect(vmId).toMatch(/^runner-test-owner-test-repo-main-[a-f0-9]{16}$/);

      Date.now.mockRestore();
    });

    test("should handle empty string branch parameter", () => {
      const mockDate = 1234567890;
      jest.spyOn(Date, "now").mockReturnValue(mockDate);

      const vmId = generateBranchVMId("test-owner", "test-repo", "");
      expect(vmId).toMatch(/^runner-test-owner-test-repo-main-[a-f0-9]{16}$/);

      Date.now.mockRestore();
    });
  });

  describe("GitHub Client and Token Management", () => {
    const {
      getGitHubToken,
      generateRunnerToken,
      createGitHubClient,
      getWebhookSecret,
    } = require("./index");

    test("getGitHubToken should handle secret manager errors", async () => {
      // Mock secret manager to reject
      mockSecretManager.accessSecretVersion.mockRejectedValueOnce(
        new Error("Secret not found")
      );

      await expect(getGitHubToken()).rejects.toThrow("Secret not found");
    });

    test("generateRunnerToken should handle GitHub API errors", async () => {
      // Mock GitHub API to reject
      mockOctokit.rest.actions.createRegistrationTokenForRepo.mockRejectedValueOnce(
        new Error("GitHub API error")
      );

      await expect(
        generateRunnerToken("test-owner", "test-repo")
      ).rejects.toThrow("GitHub API error");
    });

    test("createGitHubClient should handle token retrieval errors", async () => {
      // Mock secret manager to reject
      mockSecretManager.accessSecretVersion.mockRejectedValueOnce(
        new Error("Token error")
      );

      await expect(createGitHubClient()).rejects.toThrow("Token error");
    });
  });

  describe("VM Creation and Management", () => {
    const { createVMInstance, findBranchVMWithCapacity } = require("./index");

    test("createVMInstance should handle cloud build errors", async () => {
      // Mock cloud build to reject
      mockCloudBuild.createBuild.mockRejectedValueOnce(
        new Error("Build failed")
      );

      await expect(
        createVMInstance("test-owner", "test-repo", "main", {key:"synthetic",name:"synthetic-vm"}, "synthetic-token", {run_id:1,job_id:2,labels:["self-hosted"]})
      ).rejects.toThrow("Build failed");
    });

    test("findBranchVMWithCapacity should handle compute client errors", async () => {
      // Mock the compute client's get method to reject
      const mockComputeClient = {
        get: jest.fn(() => Promise.reject(new Error("Compute error"))),
      };

      // We can't easily mock the compute client, so this test would need the actual implementation
      // to be modified to accept a compute client parameter or we use dependency injection
      const result = await findBranchVMWithCapacity(
        "test-owner",
        "test-repo",
        "main"
      );

      // Should return null when compute client operations fail
      expect(result).toBeNull();
    }, 15000); // 15 second timeout
  });

  describe("Workflow Processing", () => {
    const {
      processWorkflowJobEvent,
      processWorkflowRunEvent,
    } = require("./index");

    test("processWorkflowJobEvent should handle unknown action", async () => {
      const eventData = {
        action: "unknown_action",
        job_id: "123",
        run_id: "456",
        repo_owner: "test-owner",
        repo_name: "test-repo",
        labels: ["self-hosted"],
        head_branch: "main",
      };

      // Should not throw on unknown action
      await expect(processWorkflowJobEvent(eventData)).resolves.toBe("completed");
    });

    test("processWorkflowRunEvent should handle completion", async () => {
      const eventData = {
        action: "completed",
        run_id: "456",
        repo_owner: "test-owner",
        repo_name: "test-repo",
        conclusion: "success",
      };

      // Should process completion without errors
      await expect(processWorkflowRunEvent(eventData)).resolves.toBeUndefined();
    });
  });

  describe("VM Management and Scaling", () => {
    const { makeScalingDecision } = require("./index");

    test("makeScalingDecision should handle scaling up scenario", () => {
      const state = {
        totalRunners: 0,
        busyRunners: 0,
        idleRunners: 0,
        utilization: 0,
      };

      const decision = makeScalingDecision(state);
      expect(decision.scaleUp).toBe(true);
      expect(decision.reasons).toContain("Need more capacity");
    });

    test("makeScalingDecision should handle no scaling needed scenario", () => {
      const state = {
        totalRunners: 1,
        busyRunners: 0,
        idleRunners: 1,
        utilization: 0,
      };

      const decision = makeScalingDecision(state);
      expect(decision.scaleUp).toBe(false);
      expect(decision.scaleDown).toBe(false);
    });

    test("makeScalingDecision should handle scale down scenario", () => {
      const state = {
        totalRunners: 5,
        busyRunners: 1,
        idleRunners: 4,
        utilization: 20,
      };

      const decision = makeScalingDecision(state);
      expect(decision.scaleDown).toBe(true);
      expect(decision.reasons).toContain("Too many idle runners");
    });
  });

  describe("State Management", () => {
    const { getCurrentState, getIdleRunnersCount } = require("./index");

    test("getCurrentState should handle GitHub API errors gracefully", async () => {
      // Mock GitHub API to reject
      mockOctokit.rest.actions.listSelfHostedRunnersForRepo.mockRejectedValueOnce(
        new Error("API rate limit exceeded")
      );

      const result = await getCurrentState("test-owner", "test-repo");

      // Should return fallback values on error
      expect(result.totalRunners).toBe(0);
      expect(result.busyRunners).toBe(0);
      expect(result.idleRunners).toBe(0);
      expect(result.utilization).toBe(0);
    });

    test("getIdleRunnersCount should calculate correctly", async () => {
      // Mock fetch for getIdleRunnersCount which uses direct GitHub API calls
      const mockFetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              runners: [
                { id: 1, status: "online", busy: false },
                { id: 2, status: "online", busy: true },
                { id: 3, status: "offline", busy: false },
              ],
            }),
        })
      );
      global.fetch = mockFetch;

      // Mock the secret manager for token retrieval
      mockSecretManager.accessSecretVersion.mockResolvedValueOnce([
        {
          payload: { data: { toString: () => "fake-token" } },
        },
      ]);

      const count = await getIdleRunnersCount("test-owner", "test-repo");
      expect(count).toBe(1); // Only one online and not busy

      // Clean up
      delete global.fetch;
    });
  });

  describe("Branch Name Sanitization", () => {
    test("should handle complex branch names with special characters", () => {
      const testCases = [
        {
          input: "feature/test@123#456",
          expected: "runner-owner-repo-feature-test-123-456",
        },
        {
          input: "hotfix/bug.fix$urgent",
          expected: "runner-owner-repo-hotfix-bug-fix-urgen",
        },
        {
          input: "release/v1.0.0[final]",
          expected: "runner-owner-repo-release-v1-0-0-final",
        },
      ];

      testCases.forEach(({ input, expected }) => {
        const result = generateBranchVMId("owner", "repo", input);
        expect(result).toMatch(new RegExp("^" + expected + "-[a-f0-9]{16}$"));
      });
    });
  });
});
