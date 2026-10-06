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

const mockFieldValue = {
  serverTimestamp: jest.fn(),
};

// Mock fetch for GitHub API calls
global.fetch = jest.fn();

// Mock the functions framework
const mockHttpHandlers = [];
const mockCloudEventHandlers = [];

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
  http: (name, handler) => {
    mockHttpHandlers.push({ name, handler });
  },
  cloudEvent: (name, handler) => {
    mockCloudEventHandlers.push({ name, handler });
  },
}));

// Mock Octokit to control GitHub API responses
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
process.env.DEFAULT_ZONE = "us-central1-a";
process.env.MAX_RUNNER_VMS = "2";

// Import the module after mocking
const webhookModule = require("./index");

describe("Webhook Handler - Edge Cases and Error Paths", () => {
  let webhookHandler;

  beforeEach(() => {
    jest.clearAllMocks();

    // Get the webhook handler
    webhookHandler = mockHttpHandlers.find(
      (h) => h.name === "webhookHandler"
    )?.handler;

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

    mockFirestore.runTransaction.mockImplementation((callback) =>
      callback({
        get: jest.fn().mockResolvedValue({
          exists: false,
        }),
        set: jest.fn(),
      })
    );

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
      data: { token: "test-registration-token" },
    });

    mockOctokit.rest.actions.listSelfHostedRunnersForRepo.mockResolvedValue({
      data: {
        total_count: 0,
        runners: [],
      },
    });

    global.fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ token: "mock-runner-token" }),
    });
  });

  describe("Secret Manager Error Paths", () => {
    test("should handle secret manager timeout", async () => {
      // Mock secret manager timeout
      mockSecretManager.accessSecretVersion.mockRejectedValue(
        new Error("Timeout accessing secret")
      );

      process.env.GITHUB_WEBHOOK_SECRET_NAME = "webhook-secret";
      delete process.env.GITHUB_WEBHOOK_SECRET;

      const req = {
        method: "POST",
        headers: {
          "x-github-event": "ping",
          "x-hub-signature-256": "sha256=test-signature",
        },
        body: { test: "data" },
      };
      const res = { status: jest.fn().mockReturnThis(), send: jest.fn() };

      await webhookHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.send).toHaveBeenCalledWith("Internal Server Error");

      // Clean up
      delete process.env.GITHUB_WEBHOOK_SECRET_NAME;
    });

    test("should handle GitHub token secret not found", async () => {
      mockSecretManager.accessSecretVersion
        .mockResolvedValueOnce([
          {
            payload: {
              data: { toString: () => "webhook-secret" },
            },
          },
        ])
        .mockRejectedValueOnce(new Error("GitHub token secret not found"));

      process.env.GITHUB_WEBHOOK_SECRET_NAME = "webhook-secret";

      const payload = {
        action: "queued",
        workflow_job: {
          id: 12345,
          run_id: 67890,
          labels: ["self-hosted", "ubuntu"],
        },
        repository: {
          owner: { login: "test-owner" },
          name: "test-repo",
        },
      };

      const payloadString = JSON.stringify(payload);
      const signature =
        "sha256=" +
        crypto
          .createHmac("sha256", "webhook-secret")
          .update(payloadString, "utf8")
          .digest("hex");

      const req = {
        method: "POST",
        headers: {
          "x-github-event": "workflow_job",
          "x-github-delivery": "delivery-token-error",
          "x-hub-signature-256": signature,
        },
        body: payload,
      };
      const res = { status: jest.fn().mockReturnThis(), send: jest.fn() };

      await webhookHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(200); // Completes successfully but logs errors

      // Clean up
      delete process.env.GITHUB_WEBHOOK_SECRET_NAME;
    });
  });

  describe("GitHub API Error Paths", () => {
    beforeEach(() => {
      // Set webhook secret environment variable to allow processing
      process.env.GITHUB_WEBHOOK_SECRET = "test-secret";
    });

    afterEach(() => {
      delete process.env.GITHUB_WEBHOOK_SECRET;
    });

    test("should handle GitHub API rate limiting", async () => {
      // Mock event not processed
      mockFirestore.get.mockResolvedValueOnce({ exists: false });

      // Mock empty current state
      mockFirestore.get
        .mockResolvedValueOnce({ forEach: () => {} }) // VMs
        .mockResolvedValueOnce({ forEach: () => {} }); // Jobs

      // Mock GitHub API rate limit error
      mockOctokit.rest.actions.createRegistrationTokenForRepo.mockRejectedValue(
        {
          status: 403,
          message: "API rate limit exceeded",
        }
      );

      const payload = {
        action: "queued",
        workflow_job: {
          id: 12345,
          run_id: 67890,
          labels: ["self-hosted", "ubuntu"],
        },
        repository: {
          owner: { login: "test-owner" },
          name: "test-repo",
        },
      };

      const payloadString = JSON.stringify(payload);
      const signature =
        "sha256=" +
        crypto
          .createHmac("sha256", "test-secret")
          .update(payloadString, "utf8")
          .digest("hex");

      const req = {
        method: "POST",
        headers: {
          "x-github-event": "workflow_job",
          "x-github-delivery": "delivery-rate-limit",
          "x-hub-signature-256": signature,
        },
        body: payload,
      };
      const res = { status: jest.fn().mockReturnThis(), send: jest.fn() };

      await webhookHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(200); // Completes successfully but logs error
    });

    test("should handle GitHub authentication errors", async () => {
      // Mock authentication error
      mockSecretManager.accessSecretVersion.mockResolvedValue([
        {
          payload: {
            data: { toString: () => "invalid-token" },
          },
        },
      ]);

      // Mock event not processed
      mockFirestore.get.mockResolvedValueOnce({ exists: false });

      const payload = {
        action: "queued",
        workflow_job: {
          id: 12345,
          run_id: 67890,
          labels: ["self-hosted", "ubuntu"],
        },
        repository: {
          owner: { login: "test-owner" },
          name: "test-repo",
        },
      };

      const payloadString = JSON.stringify(payload);
      const signature =
        "sha256=" +
        crypto
          .createHmac("sha256", "test-secret")
          .update(payloadString, "utf8")
          .digest("hex");

      const req = {
        method: "POST",
        headers: {
          "x-github-event": "workflow_job",
          "x-github-delivery": "delivery-auth-error",
          "x-hub-signature-256": signature,
        },
        body: payload,
      };
      const res = { status: jest.fn().mockReturnThis(), send: jest.fn() };

      await webhookHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(200); // Completes successfully but logs error
    });
  });

  describe("Cloud Build Error Paths", () => {
    beforeEach(() => {
      // Set webhook secret environment variable to allow processing
      process.env.GITHUB_WEBHOOK_SECRET = "test-secret";
    });

    afterEach(() => {
      delete process.env.GITHUB_WEBHOOK_SECRET;
    });

    test("should handle cloud build service unavailable", async () => {
      // Mock event not processed
      mockFirestore.get.mockResolvedValueOnce({ exists: false });

      // Mock empty current state
      mockFirestore.get
        .mockResolvedValueOnce({ forEach: () => {} }) // VMs
        .mockResolvedValueOnce({ forEach: () => {} }); // Jobs

      // Mock cloud build error
      mockCloudBuild.createBuild.mockRejectedValue(
        new Error("Cloud Build service unavailable")
      );

      const payload = {
        action: "queued",
        workflow_job: {
          id: 12345,
          run_id: 67890,
          labels: ["self-hosted", "ubuntu"],
        },
        repository: {
          owner: { login: "test-owner" },
          name: "test-repo",
        },
      };

      const payloadString = JSON.stringify(payload);
      const signature =
        "sha256=" +
        crypto
          .createHmac("sha256", "test-secret")
          .update(payloadString, "utf8")
          .digest("hex");

      const req = {
        method: "POST",
        headers: {
          "x-github-event": "workflow_job",
          "x-github-delivery": "delivery-build-error",
          "x-hub-signature-256": signature,
        },
        body: payload,
      };
      const res = { status: jest.fn().mockReturnThis(), send: jest.fn() };

      await webhookHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(500); // Build errors should return 500
    });

    test("should handle cloud build quota exceeded", async () => {
      // Mock event not processed
      mockFirestore.get.mockResolvedValueOnce({ exists: false });

      // Mock empty current state
      mockFirestore.get
        .mockResolvedValueOnce({ forEach: () => {} }) // VMs
        .mockResolvedValueOnce({ forEach: () => {} }); // Jobs

      // Mock quota exceeded error
      mockCloudBuild.createBuild.mockRejectedValue({
        code: 8, // RESOURCE_EXHAUSTED
        message: "Quota exceeded for builds",
      });

      const payload = {
        action: "queued",
        workflow_job: {
          id: 12345,
          run_id: 67890,
          labels: ["self-hosted", "ubuntu"],
        },
        repository: {
          owner: { login: "test-owner" },
          name: "test-repo",
        },
      };

      const payloadString = JSON.stringify(payload);
      const signature =
        "sha256=" +
        crypto
          .createHmac("sha256", "test-secret")
          .update(payloadString, "utf8")
          .digest("hex");

      const req = {
        method: "POST",
        headers: {
          "x-github-event": "workflow_job",
          "x-github-delivery": "delivery-quota-error",
          "x-hub-signature-256": signature,
        },
        body: payload,
      };
      const res = { status: jest.fn().mockReturnThis(), send: jest.fn() };

      await webhookHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(500); // Build errors should return 500
    });
  });

  describe("Firestore Transaction Error Paths", () => {
    test("should handle firestore transaction timeout", async () => {
      // Mock transaction timeout
      mockFirestore.runTransaction.mockRejectedValue(
        new Error("Transaction timeout")
      );

      const { acquireVMCreationLock } = require("./index");

      await expect(
        acquireVMCreationLock("test-owner", "test-repo", "main", 1000)
      ).rejects.toThrow("Transaction timeout");
    });

    test("should handle firestore lock contention", async () => {
      // Mock lock contention - lock exists and not expired
      mockFirestore.runTransaction.mockImplementation((callback) =>
        callback({
          get: jest.fn().mockResolvedValue({
            exists: true,
            data: () => ({
              expirationTime: Date.now() + 30000, // Not expired
              lockId: "another-lock",
            }),
          }),
          set: jest.fn(),
        })
      );

      const { acquireVMCreationLock } = require("./index");

      const result = await acquireVMCreationLock(
        "test-owner",
        "test-repo",
        "main",
        100
      );
      expect(result).toBeNull(); // Returns null in test environment without transactions
    });

    test("should handle firestore permission denied", async () => {
      // Mock permission denied error using Jest override pattern
      jest.doMock("@google-cloud/firestore", () => {
        return {
          Firestore: jest.fn(() => ({
            collection: jest.fn(() => ({
              doc: jest.fn(() => ({
                get: jest.fn().mockResolvedValue({ exists: false }),
                set: jest.fn(),
                delete: jest.fn(),
              })),
            })),
            runTransaction: jest.fn().mockRejectedValue({
              code: 7, // PERMISSION_DENIED
              message: "Permission denied",
            }),
          })),
        };
      });

      // Reset and re-require the module to use the new mock
      jest.resetModules();
      const { acquireVMCreationLock } = require("./index");

      // Permission denied should throw the error, not return null
      await expect(
        acquireVMCreationLock("test-owner", "test-repo", "main", 1000)
      ).rejects.toEqual({
        code: 7,
        message: "Permission denied",
      });

      // Clean up
      jest.dontMock("@google-cloud/firestore");
      jest.resetModules();
    });
  });

  describe("Lock Release Error Paths", () => {
    test("should handle lock release when document doesn't exist", async () => {
      // Mock document doesn't exist
      const mockDoc = {
        get: jest.fn().mockResolvedValue({ exists: false }),
        delete: jest.fn(),
      };

      mockFirestore.collection.mockReturnValue({
        doc: jest.fn().mockReturnValue(mockDoc),
      });

      const { releaseVMCreationLock } = require("./index");

      // Should not throw even if document doesn't exist
      await expect(
        releaseVMCreationLock("test-owner", "test-repo", "main", "test-lock-id")
      ).resolves.toBeUndefined();

      expect(mockDoc.delete).not.toHaveBeenCalled();
    });

    test("should handle lock release firestore error", async () => {
      // Mock firestore error during get
      const mockDoc = {
        get: jest
          .fn()
          .mockRejectedValue(new Error("Firestore connection failed")),
        delete: jest.fn(),
      };

      mockFirestore.collection.mockReturnValue({
        doc: jest.fn().mockReturnValue(mockDoc),
      });

      const { releaseVMCreationLock } = require("./index");

      // Function logs error but doesn't throw
      await expect(
        releaseVMCreationLock("test-owner", "test-repo", "main", "test-lock-id")
      ).resolves.toBeUndefined();
    });
  });

  describe("Complex Branch Name Handling", () => {
    beforeEach(() => {
      // Set webhook secret environment variable to allow processing
      process.env.GITHUB_WEBHOOK_SECRET = "test-secret";
    });

    afterEach(() => {
      delete process.env.GITHUB_WEBHOOK_SECRET;
    });

    test("should handle extremely long branch names", async () => {
      const longBranchName =
        "feature/" + "a".repeat(200) + "/very-long-branch-name";

      // Mock event not processed
      mockFirestore.get.mockResolvedValueOnce({ exists: false });

      // Mock empty current state
      mockFirestore.get
        .mockResolvedValueOnce({ forEach: () => {} }) // VMs
        .mockResolvedValueOnce({ forEach: () => {} }); // Jobs

      const payload = {
        action: "queued",
        workflow_job: {
          id: 12345,
          run_id: 67890,
          labels: ["self-hosted", "ubuntu"],
          head_branch: longBranchName,
        },
        repository: {
          owner: { login: "test-owner" },
          name: "test-repo",
        },
      };

      const payloadString = JSON.stringify(payload);
      const signature =
        "sha256=" +
        crypto
          .createHmac("sha256", "test-secret")
          .update(payloadString, "utf8")
          .digest("hex");

      const req = {
        method: "POST",
        headers: {
          "x-github-event": "workflow_job",
          "x-github-delivery": "delivery-long-branch",
          "x-hub-signature-256": signature,
        },
        body: payload,
      };
      const res = { status: jest.fn().mockReturnThis(), send: jest.fn() };

      await webhookHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalledWith(
        expect.stringContaining("new VMs created")
      );
    });

    test("should handle unicode characters in branch names", async () => {
      const unicodeBranchName = "feature/测试-分支-émojis-🚀";

      // Mock event not processed
      mockFirestore.get.mockResolvedValueOnce({ exists: false });

      // Mock empty current state
      mockFirestore.get
        .mockResolvedValueOnce({ forEach: () => {} }) // VMs
        .mockResolvedValueOnce({ forEach: () => {} }); // Jobs

      const payload = {
        action: "queued",
        workflow_job: {
          id: 12345,
          run_id: 67890,
          labels: ["self-hosted", "ubuntu"],
          head_branch: unicodeBranchName,
        },
        repository: {
          owner: { login: "test-owner" },
          name: "test-repo",
        },
      };

      const payloadString = JSON.stringify(payload);
      const signature =
        "sha256=" +
        crypto
          .createHmac("sha256", "test-secret")
          .update(payloadString, "utf8")
          .digest("hex");

      const req = {
        method: "POST",
        headers: {
          "x-github-event": "workflow_job",
          "x-github-delivery": "delivery-unicode-branch",
          "x-hub-signature-256": signature,
        },
        body: payload,
      };
      const res = { status: jest.fn().mockReturnThis(), send: jest.fn() };

      await webhookHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalledWith(
        expect.stringContaining("new VMs created")
      );
    });
  });

  describe("Network and External Service Errors", () => {
    beforeEach(() => {
      // Set webhook secret environment variable to allow processing
      process.env.GITHUB_WEBHOOK_SECRET = "test-secret";
    });

    afterEach(() => {
      delete process.env.GITHUB_WEBHOOK_SECRET;
    });

    test("should handle network timeout in fetch operations", async () => {
      // Mock fetch timeout
      global.fetch.mockRejectedValue(new Error("Network timeout"));

      // Mock event not processed
      mockFirestore.get.mockResolvedValueOnce({ exists: false });

      // Mock empty current state
      mockFirestore.get
        .mockResolvedValueOnce({ forEach: () => {} }) // VMs
        .mockResolvedValueOnce({ forEach: () => {} }); // Jobs

      const payload = {
        action: "queued",
        workflow_job: {
          id: 12345,
          run_id: 67890,
          labels: ["self-hosted", "ubuntu"],
        },
        repository: {
          owner: { login: "test-owner" },
          name: "test-repo",
        },
      };

      const payloadString = JSON.stringify(payload);
      const signature =
        "sha256=" +
        crypto
          .createHmac("sha256", "test-secret")
          .update(payloadString, "utf8")
          .digest("hex");

      const req = {
        method: "POST",
        headers: {
          "x-github-event": "workflow_job",
          "x-github-delivery": "delivery-network-timeout",
          "x-hub-signature-256": signature,
        },
        body: payload,
      };
      const res = { status: jest.fn().mockReturnThis(), send: jest.fn() };

      await webhookHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(200); // Completes successfully but logs error
    });

    test("should handle malformed JSON response from external services", async () => {
      // Mock malformed JSON response
      global.fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.reject(new Error("Unexpected token in JSON")),
      });

      // Mock event not processed
      mockFirestore.get.mockResolvedValueOnce({ exists: false });

      // Mock empty current state
      mockFirestore.get
        .mockResolvedValueOnce({ forEach: () => {} }) // VMs
        .mockResolvedValueOnce({ forEach: () => {} }); // Jobs

      const payload = {
        action: "queued",
        workflow_job: {
          id: 12345,
          run_id: 67890,
          labels: ["self-hosted", "ubuntu"],
        },
        repository: {
          owner: { login: "test-owner" },
          name: "test-repo",
        },
      };

      const payloadString = JSON.stringify(payload);
      const signature =
        "sha256=" +
        crypto
          .createHmac("sha256", "test-secret")
          .update(payloadString, "utf8")
          .digest("hex");

      const req = {
        method: "POST",
        headers: {
          "x-github-event": "workflow_job",
          "x-github-delivery": "delivery-malformed-json",
          "x-hub-signature-256": signature,
        },
        body: payload,
      };
      const res = { status: jest.fn().mockReturnThis(), send: jest.fn() };

      await webhookHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(200); // Completes successfully but logs error
    });
  });
});
