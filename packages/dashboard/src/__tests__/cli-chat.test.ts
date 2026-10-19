/**
 * RUFU-334 — the chat CLI lane must be handed its working directory, never inherit one.
 *
 * The reported incident was two `claude --add-dir /home/schindler/git/kb-worktrees/prod-deploy` processes
 * whose parent was the dashboard server: the chat runner passed `opts.worktreePath ?? null` and `chat.ts`
 * never supplied one, so the PTY's cwd resolved to the server's launch directory — the deployment checkout.
 * The runner's signature now requires a root, and these cases pin the two halves of that contract: the
 * root is forwarded untouched to the manager (including on the resume leg), and a missing or blank root is
 * a named refusal that spawns nothing.
 *
 * FNXC:AgentWorkingDirectoryPolicy 2026-10-18-13:10 (RUFU-334):
 * The refusal is asserted as a named error class rather than a message substring so the contract survives
 * wording changes, and the spawn call is asserted by its recorded options because the defect was a value
 * silently arriving as `null`.
 */
import { describe, expect, it, vi } from "vitest";
import type { ChatSession } from "@fusion/core";
import {
  CliChatSessionRunner,
  CliChatWorkingDirectoryMissingError,
  type ChatStoreLike,
  type CliSessionLike,
  type CliSessionManagerLike,
} from "../cli-chat.js";

const TEST_WORKTREE = "/test/chat-cli-explicit-worktree";

function makeStore(chat: Partial<ChatSession> = {}): ChatStoreLike {
  const session = {
    id: "chat-1",
    projectId: "proj-1",
    cliExecutorAdapterId: "claude",
    cliSessionFile: null,
    ...chat,
  } as ChatSession;
  return {
    getSession: vi.fn(async (id: string) => (id === session.id ? session : undefined)),
    addMessage: vi.fn(async () => ({}) as never),
    setCliExecutorAdapterId: vi.fn(async () => session),
    setCliSessionFile: vi.fn(async () => {}),
  };
}

function makeManager(spawned: CliSessionLike = { id: "cli-1", nativeSessionId: "native-1", agentState: "starting" }) {
  const spawn = vi.fn(async () => spawned);
  const manager: CliSessionManagerLike = {
    spawn,
    inject: vi.fn(async () => {}),
    getSession: vi.fn(() => spawned),
  };
  return { manager, spawn };
}

function makeRunner(store: ChatStoreLike, manager: CliSessionManagerLike) {
  return new CliChatSessionRunner({ store, manager });
}

describe("CliChatSessionRunner.ensureSession — explicit working directory", () => {
  it("forwards the caller's root verbatim to the manager spawn", async () => {
    const { manager, spawn } = makeManager();
    const runner = makeRunner(makeStore(), manager);

    await runner.ensureSession("chat-1", { projectId: "proj-1", worktreePath: TEST_WORKTREE });

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][0]).toMatchObject({
      purpose: "chat",
      chatSessionId: "chat-1",
      worktreePath: TEST_WORKTREE,
    });
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["blank whitespace", "   "],
  ])("refuses a %s root by name and spawns nothing", async (_label, value) => {
    const { manager, spawn } = makeManager();
    const runner = makeRunner(makeStore(), manager);

    const err = await runner
      .ensureSession("chat-1", { projectId: "proj-1", worktreePath: value as string })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CliChatWorkingDirectoryMissingError);
    expect((err as CliChatWorkingDirectoryMissingError).code).toBe("CLI_CHAT_WORKING_DIRECTORY_MISSING");
    expect((err as Error).message).toContain("without an explicit working directory");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("keeps the explicit root on the resume leg", async () => {
    const { manager, spawn } = makeManager();
    const store = makeStore({ cliSessionFile: "native-9" });
    const runner = makeRunner(store, manager);

    await runner.ensureSession("chat-1", { projectId: "proj-1", worktreePath: TEST_WORKTREE });

    expect(spawn.mock.calls[0][0]).toMatchObject({
      worktreePath: TEST_WORKTREE,
      resume: { sessionId: "chat-1", nativeSessionId: "native-9" },
    });
  });

  it("does not fall back to the process working directory when the caller's root is blank", async () => {
    const { manager, spawn } = makeManager();
    const runner = makeRunner(makeStore(), manager);

    const err = await runner
      .ensureSession("chat-1", { projectId: "proj-1", worktreePath: "" })
      .catch((e: unknown) => e);

    // The refusal text must not name a directory the runner invented for the caller.
    expect((err as Error).message).not.toContain(process.cwd());
    expect(spawn).not.toHaveBeenCalled();
  });
});
