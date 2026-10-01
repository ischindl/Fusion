import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock node:readline/promises before importing
vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn(),
}));

/*
FNXC:CliTests 2026-07-16-08:55:
Steering now writes through a resolved ProjectContext. Keep the real core export
shape and control only that boundary so the command cannot fall into a real store.
*/
const mockResolveProject = vi.fn();
const mockCloseProjectStore = vi.fn(async () => undefined);

vi.mock("@fusion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/core")>()),
}));

vi.mock("../project-context.js", () => ({
  resolveProject: (...args: unknown[]) => mockResolveProject(...args),
  createLocalStore: vi.fn(),
  closeProjectStore: (...args: unknown[]) => mockCloseProjectStore(...args),
}));

// Import after mocking
import { createInterface } from "node:readline/promises";
import { MAX_TASK_MESSAGE_LENGTH } from "@fusion/core";
import { runTaskSteer } from "../commands/task.js";

describe("runTaskSteer", () => {
  let mockConsoleLog: ReturnType<typeof vi.spyOn>;
  let mockConsoleError: ReturnType<typeof vi.spyOn>;
  const mockQuestion = vi.fn();
  const mockClose = vi.fn();
  const mockAddComment = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    mockConsoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockQuestion.mockReset();
    (createInterface as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      question: mockQuestion,
      close: mockClose,
    });
  });

  afterEach(() => {
    mockConsoleLog.mockRestore();
    mockConsoleError.mockRestore();
  });

  function setupTaskStoreMock(overrides: Record<string, unknown> = {}) {
    mockResolveProject.mockResolvedValue({
      projectPath: "/test/project",
      projectName: "test-project",
      isRegistered: true,
      store: {
        addSteeringComment: mockAddComment,
        ...overrides,
      },
    });
  }

  it("adds steering comment with message argument", async () => {
    setupTaskStoreMock();
    mockAddComment.mockResolvedValueOnce({
      id: "FN-001",
      title: "Test Task",
    });

    await runTaskSteer("FN-001", "Focus on error handling");

    expect(mockAddComment).toHaveBeenCalledWith("FN-001", "Focus on error handling", "user");
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining("Steering comment added to FN-001")
    );
  });

  /*
  FNXC:CommentDelivery 2026-09-27-22:15 (RUFU-259 Step 5):
  `fn task steer` is the loudest instance of this card's defect — the command an operator types believing
  the agent is listening — and its whole previous effect was the row write plus "Steering comment added".
  The assertions below pin the two halves of the fix: the appended steering row reaches the shared delivery
  seam under its OWN id (`addSteeringComment` returns the TASK, so `.id` there is the task id — the defect
  this assertion keeps dead), and the printed answer states the fate of the body. The empty fusion dir makes
  the pool deterministically empty, so `unrouted` is a real reported outcome rather than host leakage.
  */
  it("hands the appended steering row to delivery and reports the outcome instead of only the write", async () => {
    const auditEvents: Array<{ mutationType: string; metadata: Record<string, unknown> }> = [];
    setupTaskStoreMock({
      getFusionDir: () => mkdtempSync(join(tmpdir(), "fusion-cli-steer-delivery-")),
      recordRunAuditEvent: vi.fn(async (event: { mutationType: string; metadata: Record<string, unknown> }) => {
        auditEvents.push({ mutationType: event.mutationType, metadata: event.metadata });
      }),
    });
    mockAddComment.mockResolvedValueOnce({
      id: "FN-001",
      title: "Test Task",
      steeringComments: [{ id: "steer-9", text: "Focus on error handling", author: "user", createdAt: "2026-09-27T20:00:00.000Z" }],
    });

    await runTaskSteer("FN-001", "Focus on error handling");

    const delivery = auditEvents.find((event) => event.mutationType.startsWith("task:comment-delivery"));
    expect(delivery, "the command must attempt the hand-off, not only the row write").toBeDefined();
    expect(delivery!.metadata).toMatchObject({
      source: "cli-steer",
      kind: "steering",
      commentId: "steer-9",
    });
    expect(delivery!.metadata.commentId).not.toBe("FN-001");
    expect(mockConsoleLog.mock.calls.flat().join("\n")).toMatch(/no agent|delivered|nobody/i);
  });

  it("reads message from stdin when not provided as argument", async () => {
    setupTaskStoreMock();
    mockAddComment.mockResolvedValueOnce({
      id: "FN-002",
      title: "Another Task",
    });

    mockQuestion.mockResolvedValueOnce("This is a steering comment from stdin");

    await runTaskSteer("FN-002", undefined);

    expect(mockQuestion).toHaveBeenCalledWith("Message: ");
    expect(mockAddComment).toHaveBeenCalledWith("FN-002", "This is a steering comment from stdin", "user");
    expect(mockClose).toHaveBeenCalled();
  });

  it("rejects messages longer than the shared task-message limit", async () => {
    setupTaskStoreMock();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`Process.exit called with ${code}`);
    });

    const longMessage = "a".repeat(MAX_TASK_MESSAGE_LENGTH + 1);

    await expect(runTaskSteer("FN-003", longMessage)).rejects.toThrow();

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining(`Message must be between 1 and ${MAX_TASK_MESSAGE_LENGTH} characters`)
    );
    expect(mockAddComment).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it("rejects empty messages", async () => {
    setupTaskStoreMock();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`Process.exit called with ${code}`);
    });

    await expect(runTaskSteer("FN-004", "")).rejects.toThrow();

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Message is required")
    );
    expect(mockAddComment).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it("rejects whitespace-only messages", async () => {
    setupTaskStoreMock();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`Process.exit called with ${code}`);
    });

    await expect(runTaskSteer("FN-005", "   ")).rejects.toThrow();

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Message is required")
    );
    expect(mockAddComment).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it("handles task not found error (ENOENT)", async () => {
    setupTaskStoreMock();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`Process.exit called with ${code}`);
    });

    const error = new Error("Task not found") as Error & { code: string };
    error.code = "ENOENT";
    mockAddComment.mockRejectedValueOnce(error);

    await expect(runTaskSteer("KB-999", "Some message")).rejects.toThrow();

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Task not found: KB-999")
    );

    exitSpy.mockRestore();
  });

  it("shows success output with preview for short messages", async () => {
    setupTaskStoreMock();
    mockAddComment.mockResolvedValueOnce({
      id: "FN-006",
      title: "Short Message Task",
    });

    await runTaskSteer("FN-006", "Short comment");

    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining("Short comment")
    );
  });

  it("truncates long messages in success preview", async () => {
    setupTaskStoreMock();
    mockAddComment.mockResolvedValueOnce({
      id: "FN-007",
      title: "Long Message Task",
    });

    const longMessage = "a".repeat(100);
    await runTaskSteer("FN-007", longMessage);

    // Should show first 60 chars + ellipsis
    const expectedPreview = "a".repeat(60) + "…";
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining(expectedPreview)
    );
  });

  it("trims whitespace from messages", async () => {
    setupTaskStoreMock();
    mockAddComment.mockResolvedValueOnce({
      id: "FN-008",
      title: "Trim Test Task",
    });

    await runTaskSteer("FN-008", "  Some message with whitespace  ");

    expect(mockAddComment).toHaveBeenCalledWith("FN-008", "Some message with whitespace", "user");
  });

  it("accepts messages above the former limit and at the shared boundary", async () => {
    setupTaskStoreMock();
    mockAddComment.mockResolvedValueOnce({
      id: "FN-009",
      title: "Boundary Test",
    });

    // Test 1 character
    await runTaskSteer("FN-009", "x");
    expect(mockAddComment).toHaveBeenCalledWith("FN-009", "x", "user");

    // Reset mock for next test
    vi.clearAllMocks();
    setupTaskStoreMock();
    mockAddComment.mockResolvedValueOnce({
      id: "FN-010",
      title: "Boundary Test 2",
    });

    // Test above the former boundary before the shared upper boundary.
    const overFormerLimit = "b".repeat(2001);
    await runTaskSteer("FN-010", overFormerLimit);
    expect(mockAddComment).toHaveBeenCalledWith("FN-010", overFormerLimit, "user");

    vi.clearAllMocks();
    setupTaskStoreMock();
    mockAddComment.mockResolvedValueOnce({
      id: "FN-011",
      title: "Shared Boundary Test",
    });

    const atSharedLimit = "c".repeat(MAX_TASK_MESSAGE_LENGTH);
    await runTaskSteer("FN-011", atSharedLimit);
    expect(mockAddComment).toHaveBeenCalledWith("FN-011", atSharedLimit, "user");
  });

  it("rethrows non-ENOENT errors", async () => {
    setupTaskStoreMock();

    const error = new Error("Database error");
    mockAddComment.mockRejectedValueOnce(error);

    await expect(runTaskSteer("FN-011", "Message")).rejects.toThrow("Database error");
  });

  it("treats empty string as validation error, not prompt trigger", async () => {
    setupTaskStoreMock();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`Process.exit called with ${code}`);
    });

    // Empty string as argument is a validation error, not a prompt trigger
    await expect(runTaskSteer("FN-012", "")).rejects.toThrow();

    // Should NOT prompt, should error instead
    expect(mockQuestion).not.toHaveBeenCalled();
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Message is required")
    );
    expect(mockAddComment).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });
});
