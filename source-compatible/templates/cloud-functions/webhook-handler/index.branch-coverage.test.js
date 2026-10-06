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
  http: jest.fn((name, handler) => {
    mockHttpHandlers.push({ name, handler });
  }),
  cloudEvent: jest.fn((name, handler) => {
    mockCloudEventHandlers.push({ name, handler });
  }),
}));

describe("Webhook Handler - Branch Coverage Tests", () => {
  let webhookHandler;
  let processWorkflowRunEvent;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GOOGLE_CLOUD_PROJECT = "PARITY_INPUT_168";

    // Require the module after mocking
    const module = require("./index");
    webhookHandler = module.webhookHandler;
    processWorkflowRunEvent = module.processWorkflowRunEvent;

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
          exists: true,
          data: () => ({ active_runners: 0, max_runners: 8 }),
        }),
        update: jest.fn(),
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

    global.fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ token: "mock-runner-token" }),
    });
  });

  describe("Signature Verification Branches", () => {
    test("should handle rawBody signature verification", async () => {
      process.env.GITHUB_WEBHOOK_SECRET = "test-secret";

      const payload = { test: "data" };
      const payloadString = JSON.stringify(payload);
      const signature = crypto
        .createHmac("sha256", "test-secret")
        .update(payloadString, "utf8")
        .digest("hex");

      const req = {
        method: "POST",
        headers: {
          "x-github-event": "ping",
          "x-hub-signature-256": `sha256=${signature}`,
        },
        rawBody: Buffer.from(payloadString, "utf8"),
        body: payload,
      };
      const res = { status: jest.fn().mockReturnThis(), send: jest.fn() };

      await webhookHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalledWith(
        "Event received but no action required"
      );

      delete process.env.GITHUB_WEBHOOK_SECRET;
    });

    test("should handle empty payload case", async () => {
      // Ensure no webhook secret for this test
      delete process.env.GITHUB_WEBHOOK_SECRET;

      const req = {
        method: "POST",
        headers: {
          "x-github-event": "ping",
        },
        // No body or rawBody
      };
      const res = { status: jest.fn().mockReturnThis(), send: jest.fn() };

      await webhookHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalledWith(
        "Event received but no action required"
      );
    });
  });

  describe("Workflow Run Events", () => {
    beforeEach(() => {
      // Remove webhook secret for workflow_run tests
      delete process.env.GITHUB_WEBHOOK_SECRET;
    });

    test("should handle workflow_run completed event", async () => {
      const payload = {
        action: "completed",
        workflow_run: {
          id: 12345,
          conclusion: "success",
        },
        repository: {
          name: "test-repo",
          owner: {
            login: "test-owner",
          },
        },
      };

      // Mock event not processed
      mockFirestore.get.mockResolvedValueOnce({ exists: false });

      const req = {
        method: "POST",
        headers: {
          "x-github-event": "workflow_run",
          "x-github-delivery": "delivery-123",
        },
        body: payload,
      };
      const res = { status: jest.fn().mockReturnThis(), send: jest.fn() };

      await webhookHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalledWith("cleanup triggered");
    });

    test("should handle already processed workflow_run event", async () => {
      const payload = {
        action: "completed",
        workflow_run: {
          id: 12345,
          conclusion: "success",
        },
        repository: {
          name: "test-repo",
          owner: {
            login: "test-owner",
          },
        },
      };

      // Mock event already processed
      mockFirestore.get.mockResolvedValueOnce({ exists: true });

      const req = {
        method: "POST",
        headers: {
          "x-github-event": "workflow_run",
          "x-github-delivery": "delivery-123",
        },
        body: payload,
      };
      const res = { status: jest.fn().mockReturnThis(), send: jest.fn() };

      await webhookHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalledWith("Event already processed");
    });

    test("should process workflow_run event directly", async () => {
      const eventData = {
        action: "completed",
        run_id: 12345,
        repo_owner: "test-owner",
        repo_name: "test-repo",
        conclusion: "success",
      };

      await expect(processWorkflowRunEvent(eventData)).resolves.toBeUndefined();
    });
  });

  describe("Workflow Job Cancelled Branch", () => {
    beforeEach(() => {
      // Remove webhook secret for workflow_job tests
      delete process.env.GITHUB_WEBHOOK_SECRET;
    });

    test("should handle workflow_job cancelled event", async () => {
      const payload = {
        action: "cancelled",
        workflow_job: {
          id: 123,
          run_id: 456,
          labels: ["self-hosted"],
          head_branch: "main",
        },
        repository: {
          name: "test-repo",
          owner: {
            login: "test-owner",
          },
        },
      };

      // Mock event not processed
      mockFirestore.get.mockResolvedValueOnce({ exists: false });

      const req = {
        method: "POST",
        headers: {
          "x-github-event": "workflow_job",
          "x-github-delivery": "delivery-123",
        },
        body: payload,
      };
      const res = { status: jest.fn().mockReturnThis(), send: jest.fn() };

      await webhookHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalledWith("cleanup triggered");
    });
  });

  describe("VM Creation Race Condition", () => {
    test("should handle VM created while acquiring lock", async () => {
      const { processWorkflowJobEvent } = require("./index");

      const eventData = {
        action: "queued",
        job_id: 123,
        run_id: 456,
        labels: ["self-hosted"],
        repo_owner: "test-owner",
        repo_name: "test-repo",
        head_branch: "main",
      };

      // Mock Firestore to return VM already exists after lock acquisition
      mockFirestore.get
        .mockResolvedValueOnce({ exists: false }) // isEventProcessed
        .mockResolvedValueOnce({ exists: false }) // first findBranchVMWithCapacity
        .mockResolvedValueOnce({
          // second findBranchVMWithCapacity (after lock acquired)
          exists: true,
          data: () => ({
            vm_name: "runner-test-owner-test-repo-main",
            active_runners: 1,
            max_runners: 8,
          }),
        });

      // Mock lock acquisition success
      mockFirestore.runTransaction.mockImplementation((callback) =>
        callback({
          get: jest.fn().mockResolvedValue({ exists: false }),
          set: jest.fn(),
        })
      );

      await expect(processWorkflowJobEvent(eventData)).resolves.toBeUndefined();
    });

    test("should handle existing VM with capacity", async () => {
      const { processWorkflowJobEvent } = require("./index");

      const eventData = {
        action: "queued",
        job_id: 123,
        run_id: 456,
        labels: ["self-hosted"],
        repo_owner: "test-owner",
        repo_name: "test-repo",
        head_branch: "main",
      };

      // Mock Firestore to return VM with capacity immediately
      mockFirestore.get
        .mockResolvedValueOnce({ exists: false }) // isEventProcessed
        .mockResolvedValueOnce({
          // findBranchVMWithCapacity returns VM with capacity
          exists: true,
          data: () => ({
            vm_name: "runner-test-owner-test-repo-main",
            active_runners: 3,
            max_runners: 8,
          }),
        });

      await expect(processWorkflowJobEvent(eventData)).resolves.toBeUndefined();
    });

    test("should handle missing webhook secret branch", async () => {
      // Ensure no webhook secret is set
      delete process.env.GITHUB_WEBHOOK_SECRET;

      const req = {
        method: "POST",
        headers: {
          "x-github-event": "ping",
        },
        body: {},
      };
      const res = { status: jest.fn().mockReturnThis(), send: jest.fn() };

      await webhookHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalledWith(
        "Event received but no action required"
      );
    });

    test("should handle workflow_job with no branch header", async () => {
      const { processWorkflowJobEvent } = require("./index");

      const eventData = {
        action: "queued",
        job_id: 123,
        run_id: 456,
        labels: ["self-hosted"],
        repo_owner: "test-owner",
        repo_name: "test-repo",
        head_branch: null, // No branch specified
      };

      // Mock Firestore for event processing check
      mockFirestore.get.mockResolvedValueOnce({ exists: false });

      await expect(processWorkflowJobEvent(eventData)).resolves.toBeUndefined();
    });

    test("should handle VM calculation with negative job count", async () => {
      const { calculateRequiredVMs } = require("./index");

      // Test legacy signature with negative job count (should return 0 since it's treated as no metrics)
      const result = calculateRequiredVMs(-5);

      expect(result).toBe(0); // Returns 0 when no metrics available
    });

    test("should handle completed workflow_job event", async () => {
      const { processWorkflowJobEvent } = require("./index");

      const eventData = {
        action: "completed",
        job_id: 123,
        run_id: 456,
        labels: ["self-hosted"],
        repo_owner: "test-owner",
        repo_name: "test-repo",
        head_branch: "main",
      };

      await expect(processWorkflowJobEvent(eventData)).resolves.toBeUndefined();
    });
  });
});
