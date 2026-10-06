const crypto = require("crypto");

// Mock all Google Cloud dependencies with more specific mock implementations
const mockCloudBuild = {
  createBuild: jest.fn(),
};

const mockSecretManager = {
  accessSecretVersion: jest.fn(),
};

const mockFirestore = {
  collection: jest.fn(),
  doc: jest.fn(),
  get: jest.fn(),
  set: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  where: jest.fn(),
  runTransaction: jest.fn(),
};

const mockFieldValue = {
  serverTimestamp: jest.fn(),
};

// Mock fetch for GitHub API calls
global.fetch = jest.fn();

// Mock the modules
jest.mock("@google-cloud/cloudbuild", () => ({
  CloudBuildClient: jest.fn(() => mockCloudBuild),
}));

jest.mock("@google-cloud/secret-manager", () => ({
  SecretManagerServiceClient: jest.fn(() => mockSecretManager),
}));

jest.mock("@google-cloud/firestore", () => ({
  Firestore: jest.fn(() => mockFirestore),
  FieldValue: mockFieldValue,
}));

jest.mock("@google-cloud/functions-framework", () => ({
  http: jest.fn(),
  cloudEvent: jest.fn(),
}));

jest.mock("@google-cloud/compute", () => ({
  InstancesClient: jest.fn(),
}));

// Mock Octokit
const mockOctokit = {
  rest: {
    actions: {
      createRegistrationTokenForRepo: jest.fn(),
      listSelfHostedRunnersForRepo: jest.fn(),
    },
  },
};

jest.mock("@octokit/rest", () => ({
  Octokit: jest.fn(() => mockOctokit),
}));

// Set up environment variables
process.env.GOOGLE_CLOUD_PROJECT = "PARITY_INPUT_168";
process.env.GITHUB_WEBHOOK_SECRET = "test-secret";
process.env.DEFAULT_ZONE = "us-central1-a";
process.env.MAX_RUNNER_VMS = "2";

// Import the module after mocking
const {
  verifySignature,
  calculateRequiredVMs,
  isEventProcessed,
  markEventProcessed,
  getCurrentState,
  createVMInstance,
  getGitHubToken,
  generateRunnerToken,
  createGitHubClient,
  generateBranchVMId,
  findBranchVMWithCapacity,
  acquireVMCreationLock,
  releaseVMCreationLock,
  processWorkflowJobEvent,
  processWorkflowRunEvent,
} = require("./index");

// Import constants from infrastructure config
const { INFRASTRUCTURE_CONFIG } = require("./infrastructure-config");
const MAX_RUNNERS_PER_VM = INFRASTRUCTURE_CONFIG.RUNNERS_PER_VM;
const MAX_RUNNER_VMS = INFRASTRUCTURE_CONFIG.MAX_RUNNER_VMS;

describe("Webhook Handler - Comprehensive Tests", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Set up default mock implementations
    mockFirestore.collection.mockReturnValue({
      doc: jest.fn().mockReturnValue({
        get: mockFirestore.get,
        set: mockFirestore.set,
        update: mockFirestore.update,
        delete: mockFirestore.delete,
      }),
      get: mockFirestore.get,
      where: mockFirestore.where,
    });

    mockFirestore.where.mockReturnValue({
      get: mockFirestore.get,
    });

    mockFirestore.get.mockResolvedValue({
      exists: false,
      data: () => ({}),
      forEach: jest.fn(),
    });

    mockFirestore.set.mockResolvedValue({});
    mockFirestore.update.mockResolvedValue({});
    mockFirestore.delete.mockResolvedValue({});

    mockCloudBuild.createBuild.mockResolvedValue([
      { name: "build-operation-123" },
    ]);
    mockSecretManager.accessSecretVersion.mockResolvedValue([
      {
        payload: {
          data: {
            toString: () => "mock-github-token",
          },
        },
      },
    ]);

    mockOctokit.rest.actions.createRegistrationTokenForRepo.mockResolvedValue({
      data: { token: "mock-runner-token" },
    });

    mockOctokit.rest.actions.listSelfHostedRunnersForRepo.mockResolvedValue({
      data: {
        runners: [],
        total_count: 0,
      },
    });
  });

  describe("verifySignature", () => {
    test("should verify valid signature", () => {
      const payload = "test-payload";
      const secret = "test-secret";
      const expectedSignature =
        "sha256=" +
        crypto
          .createHmac("sha256", secret)
          .update(payload, "utf8")
          .digest("hex");

      const result = verifySignature(payload, expectedSignature, secret);
      expect(result).toBe(true);
    });

    test("should reject invalid signature", () => {
      const payload = "test-payload";
      const secret = "test-secret";
      const invalidSignature = "sha256=invalid-signature";

      const result = verifySignature(payload, invalidSignature, secret);
      expect(result).toBe(false);
    });

    test("should handle missing signature", () => {
      const result = verifySignature("payload", null, "secret");
      expect(result).toBe(false);
    });

    test("should handle missing secret", () => {
      const result = verifySignature("payload", "signature", null);
      expect(result).toBe(false);
    });
  });

  describe("calculateRequiredVMs", () => {
    test("should calculate VMs correctly for various scenarios", () => {
      // No metrics case
      expect(calculateRequiredVMs({})).toBe(0);

      // Scale up needed case
      const scaleUpState = {
        metrics: {
          needScaleUp: true,
          canScaleUp: true,
          reasons: { scaleUp: ["Need more capacity"] },
        },
      };
      expect(calculateRequiredVMs(scaleUpState)).toBe(1);

      // Scale down case
      const scaleDownState = {
        metrics: {
          needScaleDown: true,
          needScaleUp: false,
          canScaleUp: true,
          reasons: { scaleDown: ["Too many idle runners"] },
        },
      };
      expect(calculateRequiredVMs(scaleDownState)).toBe(0);

      // No scaling needed case
      const noScaleState = {
        metrics: {
          needScaleUp: false,
          needScaleDown: false,
          canScaleUp: true,
        },
      };
      expect(calculateRequiredVMs(noScaleState)).toBe(0);
    });

    test("should handle edge cases", () => {
      // Can't scale up case
      const cantScaleState = {
        metrics: {
          needScaleUp: true,
          canScaleUp: false,
          reasons: { scaleUp: ["At maximum capacity"] },
        },
      };
      expect(calculateRequiredVMs(cantScaleState)).toBe(0);
    });
  });

  describe("isEventProcessed", () => {
    test("should return true for processed events", async () => {
      mockFirestore.get.mockResolvedValueOnce({ exists: true });

      const result = await isEventProcessed("event-123");
      expect(result).toBe(true);
    });

    test("should return false for new events", async () => {
      mockFirestore.get.mockResolvedValueOnce({ exists: false });

      const result = await isEventProcessed("event-456");
      expect(result).toBe(false);
    });

    test("should handle Firestore errors gracefully", async () => {
      mockFirestore.get.mockRejectedValueOnce(new Error("Firestore error"));

      const result = await isEventProcessed("event-789");
      expect(result).toBe(false);
    });
  });

  describe("markEventProcessed", () => {
    test("should mark event as processed", async () => {
      const eventData = {
        event_type: "workflow_job",
        action: "queued",
        repository: "test/repo",
        job_id: "123",
      };

      await markEventProcessed("event-123", eventData);

      expect(mockFirestore.set).toHaveBeenCalledWith(
        expect.objectContaining({
          event_id: "event-123",
          processed_at: expect.any(Date),
          event_data: expect.objectContaining({
            event_type: "workflow_job",
            action: "queued",
            repository: "test/repo",
            job_id: "123",
          }),
        })
      );
    });

    test("should handle Firestore errors", async () => {
      mockFirestore.set.mockRejectedValueOnce(new Error("Firestore error"));

      await expect(markEventProcessed("event-123", {})).rejects.toThrow(
        "Firestore error"
      );
    });
  });

  describe("getCurrentState", () => {
    test("should return current state from GitHub API", async () => {
      // Mock successful GitHub token retrieval
      mockSecretManager.accessSecretVersion.mockResolvedValueOnce([
        {
          payload: {
            data: {
              toString: () => "mock-github-token",
            },
          },
        },
      ]);

      const result = await getCurrentState("test-owner", "test-repo");

      expect(result).toEqual(
        expect.objectContaining({
          totalRunners: expect.any(Number),
          busyRunners: expect.any(Number),
          idleRunners: expect.any(Number),
          utilization: expect.any(Number),
          needScaleUp: expect.any(Boolean),
          needScaleDown: expect.any(Boolean),
          metrics: expect.any(Object),
        })
      );
    });

    test("should handle API errors gracefully", async () => {
      // Mock token error
      mockSecretManager.accessSecretVersion.mockRejectedValueOnce(
        new Error("Token error")
      );

      const result = await getCurrentState("test-owner", "test-repo");

      expect(result).toEqual(
        expect.objectContaining({
          totalRunners: 0,
          busyRunners: 0,
          idleRunners: 0,
          utilization: 0,
          needScaleUp: true,
          needScaleDown: false,
        })
      );
    });
  });

  describe("getGitHubToken", () => {
    test("should get GitHub token from Secret Manager", async () => {
      mockSecretManager.accessSecretVersion.mockResolvedValueOnce([
        {
          payload: { data: { toString: () => "test-token" } },
        },
      ]);

      const result = await getGitHubToken();

      expect(result).toBe("test-token");
      expect(mockSecretManager.accessSecretVersion).toHaveBeenCalledWith({
        name: "projects/PARITY_INPUT_168/secrets/github-runner-token/versions/latest",
      });
    });

    test("should handle Secret Manager errors", async () => {
      mockSecretManager.accessSecretVersion.mockRejectedValueOnce(
        new Error("Access denied")
      );

      await expect(getGitHubToken()).rejects.toThrow("Access denied");
    });
  });

  describe("generateRunnerToken", () => {
    test("should generate runner registration token", async () => {
      const result = await generateRunnerToken("test-owner", "test-repo");

      expect(result).toBe("mock-runner-token");
      expect(
        mockOctokit.rest.actions.createRegistrationTokenForRepo
      ).toHaveBeenCalledWith({
        owner: "test-owner",
        repo: "test-repo",
      });
    });

    test("should handle GitHub API errors", async () => {
      mockOctokit.rest.actions.createRegistrationTokenForRepo.mockRejectedValueOnce(
        new Error("API Error")
      );

      await expect(
        generateRunnerToken("test-owner", "test-repo")
      ).rejects.toThrow("API Error");
    });
  });

  describe("createVMInstance", () => {
    test("should create VM instance successfully", async () => {
      const result = await createVMInstance("test-owner", "test-repo", "main");

      expect(result).toBe("runner-test-owner-test-repo-main");
      expect(mockCloudBuild.createBuild).toHaveBeenCalled();
    });

    test("should handle VM creation errors", async () => {
      mockCloudBuild.createBuild.mockRejectedValueOnce(
        new Error("Build failed")
      );

      await expect(
        createVMInstance("test-owner", "test-repo", "main")
      ).rejects.toThrow("Build failed");
    });
  });

  describe("generateBranchVMId", () => {
    test("should generate correct VM IDs for different repos", () => {
      const vmId1 = generateBranchVMId("owner1", "repo1", "main");
      const vmId2 = generateBranchVMId("owner2", "repo2", "develop");

      expect(vmId1).toBe("runner-owner1-repo1-main");
      expect(vmId2).toBe("runner-owner2-repo2-develop");
      expect(vmId1).not.toBe(vmId2);
    });

    test("should sanitize special characters in branch names", () => {
      const vmId = generateBranchVMId(
        "test-owner",
        "my-repo",
        "feature/my_feature.test"
      );

      expect(vmId).toBe("runner-test-owner-my-repo-feature-my-feature-t");
    });
  });

  describe("Constants and Configuration", () => {
    test("should have correct constants", () => {
      expect(MAX_RUNNERS_PER_VM).toBe(8);
      expect(MAX_RUNNER_VMS).toBe(2);
    });

    test("should have valid infrastructure config", () => {
      expect(INFRASTRUCTURE_CONFIG.PROJECT_ID).toBeDefined();
      expect(INFRASTRUCTURE_CONFIG.DEFAULT_ZONE).toBe("us-central1-a");
      expect(INFRASTRUCTURE_CONFIG.MAX_RUNNER_VMS).toBe(2);
      expect(INFRASTRUCTURE_CONFIG.RUNNERS_PER_VM).toBe(8);
    });
  });
});
