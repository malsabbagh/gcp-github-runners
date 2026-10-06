const crypto = require("crypto");

// Mock all Google Cloud dependencies
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

// Mock Octokit
const mockOctokit = {
  rest: {
    actions: {
      createRegistrationTokenForRepo: jest.fn(),
      listSelfHostedRunnersForRepo: jest.fn(),
    },
  },
};

jest.mock("@google-cloud/cloudbuild", () => ({
  CloudBuildClient: jest.fn(() => mockCloudBuild),
}));

jest.mock("@google-cloud/compute", () => ({
  InstancesClient: jest.fn(() => ({})),
}));

jest.mock("@google-cloud/secret-manager", () => ({
  SecretManagerServiceClient: jest.fn(() => mockSecretManager),
}));

jest.mock("@google-cloud/firestore", () => ({
  Firestore: jest.fn(() => mockFirestore),
  FieldValue: { serverTimestamp: jest.fn() },
}));

jest.mock("@google-cloud/functions-framework", () => ({
  http: jest.fn(),
  cloudEvent: jest.fn(),
}));

jest.mock("@octokit/rest", () => ({
  Octokit: jest.fn(() => mockOctokit),
}));

// Set up environment variables
process.env.GOOGLE_CLOUD_PROJECT = "PARITY_INPUT_168";
process.env.GITHUB_WEBHOOK_SECRET = "test-secret";
process.env.DEFAULT_ZONE = "us-central1-a";
process.env.MAX_RUNNER_VMS = "2";
process.env.RUNNERS_PER_VM = "8";

// Import the module after mocking
const {
  verifySignature,
  createVMInstance,
  getGitHubToken,
  generateRunnerToken,
  generateBranchVMId,
  findBranchVMWithCapacity,
  acquireVMCreationLock,
  releaseVMCreationLock,
  processWorkflowJobEvent,
  isEventProcessed,
} = require("./index");

describe("Additional Coverage Tests", () => {
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
  });

  describe("VM Lock Management", () => {
    test("acquireVMCreationLock should acquire lock successfully", async () => {
      mockFirestore.runTransaction.mockImplementation(async (callback) => {
        const transaction = {
          get: jest.fn().mockResolvedValue({ exists: false }),
          set: jest.fn(),
          update: jest.fn(),
        };
        return await callback(transaction);
      });

      const result = await acquireVMCreationLock(
        "test-repo-owner",
        "test-repo-name",
        "main"
      );
      expect(result).toBe(true);
    });

    test("releaseVMCreationLock should release lock", async () => {
      await releaseVMCreationLock("test-vm-id");
      expect(mockFirestore.delete).toHaveBeenCalled();
    });
  });

  describe("VM Creation", () => {
    test("createVMInstance should create VM successfully", async () => {
      const result = await createVMInstance("test-owner", "test-repo", "main");
      expect(result).toBe("runner-test-owner-test-repo-main");
      expect(mockCloudBuild.createBuild).toHaveBeenCalled();
    });

    test("generateBranchVMId should generate correct IDs", () => {
      const vmId = generateBranchVMId("test-owner", "test-repo", "main");
      expect(vmId).toBe("runner-test-owner-test-repo-main");
    });

    test("generateBranchVMId should handle special characters", () => {
      const vmId = generateBranchVMId(
        "test-owner",
        "test-repo",
        "feature/test_branch"
      );
      expect(vmId).toBe("runner-test-owner-test-repo-feature-test-branch");
    });
  });

  describe("VM Capacity", () => {
    test("findBranchVMWithCapacity should find VM with capacity", async () => {
      mockFirestore.get.mockResolvedValueOnce({
        forEach: (callback) => {
          callback({
            id: "vm-1",
            data: () => ({
              active_runners: 5,
              max_runners: 8,
              status: "running",
              vm_name: "runner-vm-1",
            }),
          });
        },
      });

      const result = await findBranchVMWithCapacity("test-owner", "test-repo");
      expect(result).toEqual({
        vm_id: "vm-1",
        vm_name: "runner-vm-1",
        active_runners: 5,
        max_runners: 8,
        status: "running",
      });
    });
  });

  describe("GitHub API", () => {
    test("generateRunnerToken should generate token", async () => {
      const token = await generateRunnerToken("test-owner", "test-repo");
      expect(token).toBe("mock-runner-token");
    });

    test("getGitHubToken should get token from Secret Manager", async () => {
      const result = await getGitHubToken();
      expect(result).toBe("mock-github-token");
    });
  });

  describe("Event Processing", () => {
    test("isEventProcessed should handle errors gracefully", async () => {
      mockFirestore.get.mockRejectedValueOnce(new Error("Firestore error"));

      const result = await isEventProcessed("event-123");
      expect(result).toBe(false); // Should default to false on error
    });

    test("processWorkflowJobEvent should handle queued jobs", async () => {
      mockFirestore.get.mockResolvedValueOnce({
        forEach: (callback) => {
          callback({
            id: "vm-1",
            data: () => ({
              active_runners: 2,
              max_runners: 8,
              status: "running",
            }),
          });
        },
      });

      const eventData = {
        action: "queued",
        repo_owner: "test-owner",
        repo_name: "test-repo",
        job_id: "job-123",
        branch: "main",
        labels: ["self-hosted"],
      };

      await processWorkflowJobEvent(eventData);
      expect(mockFirestore.get).toHaveBeenCalled();
    });
  });

  describe("Error Cases", () => {
    test("signature verification edge cases", () => {
      expect(verifySignature("payload", null, "secret")).toBe(false);
      expect(verifySignature("payload", "", "secret")).toBe(false);
      expect(verifySignature("payload", "invalid", "secret")).toBe(false);
    });

    test("createVMInstance should handle errors", async () => {
      mockCloudBuild.createBuild.mockRejectedValueOnce(
        new Error("Build failed")
      );

      await expect(
        createVMInstance("test-owner", "test-repo", "main")
      ).rejects.toThrow("Build failed");
    });
  });
});
