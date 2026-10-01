/*
FNXC:CommentDelivery 2026-09-27-18:05 (RUFU-259):
RUFU-251 was measured from exactly this surface: a task-execution session woken with
`triggering comments: 1`, whose four `fn_task_show` calls returned no comment body, whose dashboard API
is 401 to an agent, and whose worktree holds no `task.json` to read. The pi extension's `fn_task_show`
is therefore the lane where an advertised id has to resolve, and it is pinned here against the real
registered tool rather than against a copy of its rendering code.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskNotFoundError, type Task, type TaskStore } from "@fusion/core";
import { createMockApi, registerExtension, requireTool } from "./pg-extension-harness.js";
import { __setCachedStoreForTesting, closeCachedStores } from "../extension.js";

const COMMENT_ID = "1758-comment-body-under-test";
const STEERING_ID = "1758-steering-body-under-test";
const COMMENT_BODY = "rebase onto main before the parser change";
const STEERING_BODY = "do not widen the lockfile";

function card(): Task {
  return {
    id: "FN-259",
    title: "Comment delivery",
    description: "Make advertised comment ids readable from the agent lane",
    column: "in-progress",
    status: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    prompt: "# Prompt body",
    log: [],
    comments: [
      { id: COMMENT_ID, text: COMMENT_BODY, author: "user", createdAt: "2026-09-27T10:00:00.000Z" },
      { id: STEERING_ID, text: STEERING_BODY, author: "user", createdAt: "2026-09-27T10:10:00.000Z" },
    ],
    steeringComments: [
      { id: STEERING_ID, text: STEERING_BODY, author: "user", createdAt: "2026-09-27T10:10:00.000Z" },
    ],
  } as unknown as Task;
}

async function showWith(params: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rufu259-ext-comment-"));
  await mkdir(join(root, ".fusion"), { recursive: true });
  __setCachedStoreForTesting(root, {
    getTask: vi.fn(async (id: string) => {
      if (id !== "FN-259") throw new TaskNotFoundError(id);
      return card();
    }),
  } as unknown as TaskStore);

  try {
    const api = createMockApi();
    registerExtension(api);
    const show = requireTool(api, "fn_task_show");
    const result = await show.execute("call", params, undefined, undefined, { cwd: root });
    return result.content.map((part) => part.text).join("\n");
  } finally {
    await closeCachedStores();
    await rm(root, { recursive: true, force: true });
  }
}

describe("pi extension fn_task_show commentIds", () => {
  afterEach(async () => {
    await closeCachedStores();
  });

  it("returns the body behind a comment id the wake advertised", async () => {
    const text = await showWith({ id: "FN-259", commentIds: [COMMENT_ID] });
    expect(text).toContain(`[${COMMENT_ID}] comment by user at`);
    expect(text).toContain(COMMENT_BODY);
  });

  it("labels a steering id as steering so the agent knows it is operator steering", async () => {
    const text = await showWith({ id: "FN-259", commentIds: [STEERING_ID] });
    expect(text).toContain(`[${STEERING_ID}] steering by user at`);
    expect(text).toContain(STEERING_BODY);
  });

  it("says so when an advertised id is not on the card, instead of printing nothing", async () => {
    const text = await showWith({ id: "FN-259", commentIds: ["msg-phantom"] });
    expect(text).toContain("[msg-phantom] not found on this card");
  });

  it("leaves an unrequested read byte-for-byte comment-free", async () => {
    const text = await showWith({ id: "FN-259" });
    expect(text).toContain("Prompt:");
    expect(text).not.toContain("Comments:");
    expect(text).not.toContain(COMMENT_BODY);
  });
});
