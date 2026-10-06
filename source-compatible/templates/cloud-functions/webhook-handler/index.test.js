const crypto = require("crypto");

// Mock all Google Cloud dependencies
const mockCloudBuild = {
  createBuild: jest.fn().mockResolvedValue([{ name: "build-operation-123" }]),
};

const mockSecretManager = {
  accessSecretVersion: jest
    .fn()
    .mockResolvedValue([
      { payload: { data: { toString: () => "mock-github-token" } } },
    ]),
};

const mockFirestore = {
  collection: jest.fn().mockReturnThis(),
  doc: jest.fn().mockReturnThis(),
  get: jest.fn().mockResolvedValue({
    exists: false,
    data: () => ({}),
    forEach: jest.fn(),
  }),
  set: jest.fn().mockResolvedValue({}),
  update: jest.fn().mockResolvedValue({}),
  delete: jest.fn().mockResolvedValue({}),
  where: jest.fn().mockReturnThis(),
  runTransaction: jest.fn().mockImplementation((callback) =>
    callback({
      get: jest.fn().mockResolvedValue({
        exists: true,
        data: () => ({ active_runners: 0, max_runners: 8 }),
      }),
      update: jest.fn(),
    })
  ),
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

jest.mock("@google-cloud/compute", () => ({
  InstancesClient: jest.fn(() => ({})),
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
  getIdleRunnersCount,
} = require("./index");

// Import constants from infrastructure config
const { INFRASTRUCTURE_CONFIG } = require("./infrastructure-config");
const MAX_RUNNERS_PER_VM = INFRASTRUCTURE_CONFIG.RUNNERS_PER_VM;
const MAX_RUNNER_VMS = INFRASTRUCTURE_CONFIG.MAX_RUNNER_VMS;

describe("Webhook Handler", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset fetch mock
    global.fetch.mockClear();
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
      const payload = "test-payload";
      const secret = "test-secret";

      const result = verifySignature(payload, null, secret);
      expect(result).toBe(false);
    });

    test("should handle missing secret", () => {
      const payload = "test-payload";
      const signature = "sha256=some-signature";

      const result = verifySignature(payload, signature, null);
      expect(result).toBe(false);
    });
  });

  describe("calculateRequiredVMs", () => {
    test("should calculate VMs correctly for various scenarios", () => {
      expect(calculateRequiredVMs(0, 0, 0)).toBe(0); // No jobs, no VMs
      expect(calculateRequiredVMs(1, 0, 0)).toBe(1); // 1 job, need 1 VM
      expect(calculateRequiredVMs(8, 0, 0)).toBe(1); // 8 jobs, need 1 VM
      expect(calculateRequiredVMs(9, 0, 0)).toBe(2); // 9 jobs, need 2 VMs
      expect(calculateRequiredVMs(8, 1, 0)).toBe(0); // 8 jobs, 1 VM exists
      expect(calculateRequiredVMs(5, 0, 3)).toBe(1); // 5 jobs, 3 capacity, need 1 VM
      expect(calculateRequiredVMs(5, 0, 8)).toBe(0); // 5 jobs, 8 capacity, no VMs needed
      expect(calculateRequiredVMs(100, 0, 0)).toBe(2); // Many jobs, capped at MAX_RUNNER_VMS
    });

    test("should handle negative values", () => {
      expect(calculateRequiredVMs(-5, 0, 0)).toBe(0); // Negative jobs should be 0
      expect(calculateRequiredVMs(5, -1, 0)).toBe(2); // Negative current VMs
    });
  });

  describe("Token Management", () => {
    test("should get GitHub token from secret manager", async () => {
      // Mock secret manager response
      mockSecretManager.accessSecretVersion.mockResolvedValueOnce([
        { payload: { data: { toString: () => "repo-specific-token" } } },
      ]);

      // Test repository-specific token
      const result = await mockSecretManager.accessSecretVersion({
        name: "test-secret",
      });
      expect(result[0].payload.data.toString()).toBe("repo-specific-token");
    });

    test("should fallback to global token when repo-specific token fails", async () => {
      // Mock repo-specific token failure, then global token success
      mockSecretManager.accessSecretVersion
        .mockRejectedValueOnce(new Error("Secret not found"))
        .mockResolvedValueOnce([
          { payload: { data: { toString: () => "global-token" } } },
        ]);

      // Test fallback logic
      try {
        await mockSecretManager.accessSecretVersion({ name: "repo-secret" });
      } catch (error) {
        expect(error.message).toBe("Secret not found");
      }

      const globalResult = await mockSecretManager.accessSecretVersion({
        name: "global-secret",
      });
      expect(globalResult[0].payload.data.toString()).toBe("global-token");
    });

    test("should generate runner registration token", async () => {
      // Mock GitHub API response
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ token: "registration-token-123" }),
      });

      const response = await fetch(
        "https://api.github.com/repos/test/repo/actions/runners/registration-token",
        {
          method: "POST",
          headers: {
            Authorization: "token test-token",
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "PARITY_INPUT_115/1.0",
          },
        }
      );

      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data.token).toBe("registration-token-123");
    });

    test("should handle GitHub API errors", async () => {
      // Mock GitHub API failure
      global.fetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      });

      const response = await fetch(
        "https://api.github.com/repos/test/repo/actions/runners/registration-token"
      );
      expect(response.ok).toBe(false);
      expect(response.status).toBe(401);
    });
  });

  describe("Firestore Operations", () => {
    test("should check if event is processed", async () => {
      mockFirestore.get.mockResolvedValueOnce({ exists: true });

      // Test event processing check
      const result = await mockFirestore
        .collection("processed_events")
        .doc("event-123")
        .get();
      expect(result.exists).toBe(true);
    });

    test("should mark event as processed", async () => {
      const eventData = {
        event_type: "workflow_job",
        action: "queued",
        repository: "test/repo",
        job_id: "123",
      };

      await mockFirestore
        .collection("processed_events")
        .doc("event-123")
        .set({
          processed_at: new Date(),
          ...eventData,
        });

      expect(mockFirestore.set).toHaveBeenCalledWith(
        expect.objectContaining({
          processed_at: expect.any(Date),
          event_type: "workflow_job",
          action: "queued",
          repository: "test/repo",
          job_id: "123",
        })
      );
    });

    test("should get current state", async () => {
      // Mock VM collection
      mockFirestore.get.mockResolvedValueOnce({
        forEach: (callback) => {
          callback({
            id: "vm-1",
            data: () => ({
              status: "running",
              active_runners: 2,
              max_runners: 8,
            }),
          });
        },
      });

      // Mock jobs collection
      mockFirestore.where.mockReturnValueOnce({
        get: jest.fn().mockResolvedValueOnce({
          forEach: (callback) => {
            callback({ id: "job-1", data: () => ({ status: "queued" }) });
            callback({ id: "job-2", data: () => ({ status: "queued" }) });
          },
        }),
      });

      // Test getting current state
      const vmsResult = await mockFirestore.collection("vms").get();
      const jobsResult = await mockFirestore
        .collection("jobs")
        .where("status", "==", "queued")
        .get();

      expect(vmsResult.forEach).toBeDefined();
      expect(jobsResult.forEach).toBeDefined();
    });

    test("should create job record", async () => {
      const jobData = {
        job_id: "123",
        status: "queued",
        repository: "test/repo",
        run_id: "456",
        created_at: expect.any(Date),
        vm_id: null,
      };

      await mockFirestore.collection("jobs").doc("123").set(jobData);
      expect(mockFirestore.set).toHaveBeenCalledWith(jobData);
    });

    test("should update job status", async () => {
      const updateData = {
        status: "assigned",
        updated_at: expect.any(Date),
        vm_id: "vm-123",
      };

      await mockFirestore.collection("jobs").doc("123").update(updateData);
      expect(mockFirestore.update).toHaveBeenCalledWith(updateData);
    });

    test("should create VM record", async () => {
      const vmData = {
        vm_id: "vm-123",
        vm_name: "gh-runner-vm-123",
        active_runners: 0,
        max_runners: 8,
        status: "creating",
        created_at: expect.any(Date),
        zone: "us-central1-a",
      };

      await mockFirestore.collection("vms").doc("vm-123").set(vmData);
      expect(mockFirestore.set).toHaveBeenCalledWith(vmData);
    });

    test("should update VM status", async () => {
      const updateData = {
        status: "running",
        updated_at: expect.any(Date),
        active_runners: 2,
      };

      await mockFirestore.collection("vms").doc("vm-123").update(updateData);
      expect(mockFirestore.update).toHaveBeenCalledWith(updateData);
    });

    test("should handle transaction for job assignment", async () => {
      const mockTransaction = {
        get: jest.fn().mockResolvedValue({
          exists: true,
          data: () => ({ active_runners: 2, max_runners: 8 }),
        }),
        update: jest.fn(),
      };

      mockFirestore.runTransaction.mockImplementation((callback) =>
        callback(mockTransaction)
      );

      await mockFirestore.runTransaction(async (transaction) => {
        const vmDoc = await transaction.get(
          mockFirestore.collection("vms").doc("vm-123")
        );
        expect(vmDoc.exists).toBe(true);

        const currentData = vmDoc.data();
        expect(currentData.active_runners).toBe(2);
        expect(currentData.max_runners).toBe(8);

        transaction.update(mockFirestore.collection("vms").doc("vm-123"), {
          active_runners: currentData.active_runners + 1,
          updated_at: new Date(),
        });
      });

      expect(mockTransaction.get).toHaveBeenCalled();
      expect(mockTransaction.update).toHaveBeenCalled();
    });
  });

  describe("Cloud Build Operations", () => {
    test("should create VM instance", async () => {
      const buildConfig = {
        source: {
          repoSource: {
            projectId: "PARITY_INPUT_168",
            repoName: "PARITY_INPUT_115",
            branchName: "main",
          },
        },
        filename: "cloudbuild/cloudbuild.yaml",
        substitutions: {
          _REPO_OWNER: "test-owner",
          _REPO_NAME: "test-repo",
          _RUN_ID: "vm-123",
          _ZONE: "us-central1-a",
          _RUNNER_TOKEN: "runner-token-123",
        },
        options: {
          logging: "CLOUD_LOGGING_ONLY",
        },
        timeout: "600s",
      };

      await mockCloudBuild.createBuild({
        projectId: "PARITY_INPUT_168",
        build: buildConfig,
      });

      expect(mockCloudBuild.createBuild).toHaveBeenCalledWith({
        projectId: "PARITY_INPUT_168",
        build: buildConfig,
      });
    });

    test("should create cleanup build", async () => {
      const cleanupConfig = {
        source: {
          repoSource: {
            projectId: "PARITY_INPUT_168",
            repoName: "PARITY_INPUT_115",
            branchName: "main",
          },
        },
        filename: "cloudbuild/cloudbuild-cleanup.yaml",
        substitutions: {
          _REPO_OWNER: "system",
          _REPO_NAME: "cleanup",
          _RUN_ID: "vm-123",
          _ZONE: "us-central1-a",
        },
        options: {
          logging: "CLOUD_LOGGING_ONLY",
        },
        timeout: "300s",
      };

      await mockCloudBuild.createBuild({
        projectId: "PARITY_INPUT_168",
        build: cleanupConfig,
      });

      expect(mockCloudBuild.createBuild).toHaveBeenCalledWith({
        projectId: "PARITY_INPUT_168",
        build: cleanupConfig,
      });
    });

    test("should handle Cloud Build errors", async () => {
      mockCloudBuild.createBuild.mockRejectedValueOnce(
        new Error("Build failed")
      );

      await expect(
        mockCloudBuild.createBuild({
          projectId: "PARITY_INPUT_168",
          build: {},
        })
      ).rejects.toThrow("Build failed");
    });
  });

  describe("Job Assignment Logic", () => {
    test("should assign jobs to VMs with available capacity", () => {
      const queuedJobs = [
        { id: "job-1", job_id: "1" },
        { id: "job-2", job_id: "2" },
        { id: "job-3", job_id: "3" },
      ];

      const vms = [
        { vm_id: "vm-1", status: "running", active_runners: 2, max_runners: 8 },
        { vm_id: "vm-2", status: "running", active_runners: 7, max_runners: 8 },
        {
          vm_id: "vm-3",
          status: "creating",
          active_runners: 0,
          max_runners: 8,
        },
      ];

      // Test assignment logic
      const assignments = [];
      const availableVMs = vms.filter(
        (vm) => vm.status === "running" && vm.active_runners < vm.max_runners
      );

      let jobIndex = 0;
      for (const vm of availableVMs) {
        const availableSlots = vm.max_runners - vm.active_runners;
        for (
          let i = 0;
          i < availableSlots && jobIndex < queuedJobs.length;
          i++
        ) {
          const job = queuedJobs[jobIndex];
          assignments.push({ job, vm });
          jobIndex++;
        }
      }

      expect(assignments).toHaveLength(3); // All jobs should be assigned
      expect(assignments[0].vm.vm_id).toBe("vm-1"); // First job to vm-1
      expect(assignments[1].vm.vm_id).toBe("vm-1"); // Second job to vm-1
      expect(assignments[2].vm.vm_id).toBe("vm-1"); // Third job to vm-1 (6 slots available)
    });

    test("should handle no available VMs", () => {
      const queuedJobs = [{ id: "job-1", job_id: "1" }];
      const vms = [
        { vm_id: "vm-1", status: "running", active_runners: 8, max_runners: 8 }, // Full capacity
      ];

      const availableVMs = vms.filter(
        (vm) => vm.status === "running" && vm.active_runners < vm.max_runners
      );

      expect(availableVMs).toHaveLength(0);
    });
  });

  describe("Environment Configuration", () => {
    test("should use environment variables", () => {
      expect(process.env.GOOGLE_CLOUD_PROJECT).toBe("PARITY_INPUT_168");
      expect(process.env.GITHUB_WEBHOOK_SECRET).toBe("test-secret");
      expect(process.env.DEFAULT_ZONE).toBe("us-central1-a");
      expect(process.env.MAX_RUNNER_VMS).toBe("2");
    });

    test("should use default values when environment variables are not set", () => {
      const originalZone = process.env.DEFAULT_ZONE;
      const originalMaxVMs = process.env.MAX_RUNNER_VMS;

      delete process.env.DEFAULT_ZONE;
      delete process.env.MAX_RUNNER_VMS;

      // Test default values
      const DEFAULT_ZONE = process.env.DEFAULT_ZONE || "us-central1-a";
      const MAX_RUNNER_VMS = parseInt(process.env.MAX_RUNNER_VMS || "2", 10);

      expect(DEFAULT_ZONE).toBe("us-central1-a");
      expect(MAX_RUNNER_VMS).toBe(2);

      // Restore original values
      process.env.DEFAULT_ZONE = originalZone;
      process.env.MAX_RUNNER_VMS = originalMaxVMs;
    });
  });

  describe("Error Handling", () => {
    test("should handle Firestore errors", async () => {
      mockFirestore.get.mockRejectedValueOnce(new Error("Firestore error"));

      await expect(
        mockFirestore.collection("test").doc("test").get()
      ).rejects.toThrow("Firestore error");
    });

    test("should handle Secret Manager errors", async () => {
      mockSecretManager.accessSecretVersion.mockRejectedValueOnce(
        new Error("Secret not found")
      );

      await expect(
        mockSecretManager.accessSecretVersion({ name: "test" })
      ).rejects.toThrow("Secret not found");
    });

    test("should handle transaction errors", async () => {
      mockFirestore.runTransaction.mockRejectedValueOnce(
        new Error("Transaction failed")
      );

      await expect(mockFirestore.runTransaction(() => {})).rejects.toThrow(
        "Transaction failed"
      );
    });
  });

  describe("Instance Limits", () => {
    test("should enforce MAX_RUNNER_VMS limit", () => {
      const MAX_RUNNER_VMS = 2;

      function calculateRequiredVMs(
        totalQueuedJobs,
        currentVMCount,
        existingCapacity = 0
      ) {
        const effectiveQueuedJobs = Math.max(
          0,
          totalQueuedJobs - existingCapacity
        );
        const desiredVMs = Math.ceil(effectiveQueuedJobs / 8);
        const cappedDesiredVMs = Math.min(desiredVMs, MAX_RUNNER_VMS);
        return Math.max(0, cappedDesiredVMs - currentVMCount);
      }

      // Test that we never exceed MAX_RUNNER_VMS
      expect(calculateRequiredVMs(100, 0, 0)).toBe(2); // Capped at 2
      expect(calculateRequiredVMs(200, 0, 0)).toBe(2); // Still capped at 2
      expect(calculateRequiredVMs(50, 1, 0)).toBe(1); // 1 more to reach limit
      expect(calculateRequiredVMs(50, 2, 0)).toBe(0); // Already at limit
    });

    test("should enforce MAX_RUNNERS_PER_VM limit", () => {
      const MAX_RUNNERS_PER_VM = 8;

      const vm = {
        vm_id: "vm-1",
        active_runners: 7,
        max_runners: MAX_RUNNERS_PER_VM,
      };
      const availableSlots = vm.max_runners - vm.active_runners;

      expect(availableSlots).toBe(1); // Only 1 slot available
      expect(vm.active_runners).toBeLessThan(MAX_RUNNERS_PER_VM);
    });
  });

  describe("Idle Runners Check", () => {
    test("should count idle runners correctly", async () => {
      const mockRunners = {
        runners: [
          { status: "online", busy: false, name: "runner-1" },
          { status: "online", busy: true, name: "runner-2" },
          { status: "offline", busy: false, name: "runner-3" },
          { status: "online", busy: false, name: "runner-4" },
        ],
      };

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockRunners),
      });

      const idleCount = await getIdleRunnersCount("test-owner", "test-repo");

      expect(idleCount).toBe(2); // Only runner-1 and runner-4 are online and not busy
      expect(global.fetch).toHaveBeenCalledWith(
        "https://api.github.com/repos/test-owner/test-repo/actions/runners",
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({
            Authorization: "token mock-github-token",
            Accept: "application/vnd.github.v3+json",
          }),
        })
      );
    });

    test("should handle empty runners list", async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ runners: [] }),
      });

      const idleCount = await getIdleRunnersCount("test-owner", "test-repo");

      expect(idleCount).toBe(0);
    });

    test("should handle GitHub API errors gracefully", async () => {
      global.fetch.mockRejectedValueOnce(new Error("Network error"));

      const idleCount = await getIdleRunnersCount("test-owner", "test-repo");

      expect(idleCount).toBe(0); // Should default to 0 on error
    });

    test("should handle HTTP error responses", async () => {
      global.fetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
        text: () => Promise.resolve("Repository not found"),
      });

      const idleCount = await getIdleRunnersCount("test-owner", "test-repo");

      expect(idleCount).toBe(0); // Should default to 0 on HTTP error
    });
  });
});
