/*
FNXC:CommentDelivery 2026-09-27-17:55 (RUFU-259):
`fn_task_show` exists five times over — the shared factory, triage's bespoke copy, the planning-board
lane, the pi extension, and the CLI — and a wake delta cannot know which lane it woke. So the comment
read surface cannot be correct on one surface and missing on another: an id a heartbeat advertised must
return the same body from whichever lane the woken agent happens to be holding.

These tests pin that parity behaviorally (the pi-extension variant is behavior-covered in
`packages/cli/src/__tests__/extension-comment-read.test.ts` against the real registered tool) and pin
the two honesty rules the id parameter exists to serve: an unrequested call renders no Comments section
at all, and a store failure keeps saying "board unavailable" rather than "not found".
*/
import { describe, expect, it, vi } from "vitest";
import { TaskNotFoundError, type TaskDetail, type TaskStore } from "@fusion/core";
import { createPlanningBoardTools } from "../../../dashboard/src/planning-board-tools.js";
import { createTaskReadTools } from "../agent-tools.js";
import { STORE_RETRY_GUIDANCE } from "../tool-store-errors.js";
import { TriageProcessor } from "../triage.js";

const COMMENT_ID = "1758-aaaaaa";
const STEERING_ID = "1758-bbbbbb";
const BODY = "rebase onto main before touching the parser";
const STEERING_BODY = "stop widening the lockfile";

function cardWithComments(): TaskDetail {
  return {
    id: "FN-259",
    title: "Comment delivery",
    description: "Make advertised comment ids readable",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    prompt: "# Prompt body",
    comments: [
      { id: COMMENT_ID, text: BODY, author: "user", createdAt: "2026-09-27T10:00:00.000Z" },
      { id: STEERING_ID, text: STEERING_BODY, author: "user", createdAt: "2026-09-27T10:10:00.000Z" },
    ],
    steeringComments: [
      { id: STEERING_ID, text: STEERING_BODY, author: "user", createdAt: "2026-09-27T10:10:00.000Z" },
    ],
  } as unknown as TaskDetail;
}

function storeReturningCard(): TaskStore {
  return {
    getTask: vi.fn(async () => cardWithComments()),
    listTasks: vi.fn(async () => []),
    searchTasks: vi.fn(async () => []),
    getSettings: vi.fn(async () => ({})),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as TaskStore;
}

function bodyOf(result: { content: unknown }): string {
  const first = (result.content as Array<{ type: string; text?: string }>)[0];
  return first?.text ?? "";
}

function runSharedFactoryShow(store: TaskStore, params: Record<string, unknown>): Promise<unknown> {
  const tools = createTaskReadTools(store);
  const show = tools.find((tool) => tool.name === "fn_task_show")!;
  return show.execute("show", params);
}

async function showFromSharedFactory(params: Record<string, unknown>): Promise<string> {
  return bodyOf(await runSharedFactoryShow(storeReturningCard(), params));
}

async function showFromTriage(params: Record<string, unknown>): Promise<string> {
  const processor = new TriageProcessor(storeReturningCard() as never, "/tmp/fn-test");
  const tools = (
    processor as unknown as {
      createTriageTools: (opts: unknown) => Array<{ name: string; execute: (id: string, params: unknown) => Promise<unknown> }>;
    }
  ).createTriageTools({ parentTaskId: "FN-259", allowTaskCreate: false });
  const show = tools.find((tool) => tool.name === "fn_task_show")!;
  return bodyOf(await show.execute("show", params));
}

async function showFromPlanningBoard(params: Record<string, unknown>): Promise<string> {
  const tools = createPlanningBoardTools(storeReturningCard());
  const show = tools.find((tool) => tool.name === "fn_task_show")!;
  return bodyOf(await show.execute("show", params));
}

const surfaces = {
  sharedFactory: showFromSharedFactory,
  triage: showFromTriage,
  planningBoard: showFromPlanningBoard,
};

describe("fn_task_show commentIds parity", () => {
  for (const [name, show] of Object.entries(surfaces)) {
    it(`${name} returns the body of a requested comment id`, async () => {
      const text = await show({ id: "FN-259", commentIds: [COMMENT_ID] });
      expect(text).toContain(`[${COMMENT_ID}] comment by user at`);
      expect(text).toContain(BODY);
    });

    it(`${name} labels a steering id as steering`, async () => {
      const text = await show({ id: "FN-259", commentIds: [STEERING_ID] });
      expect(text).toContain(`[${STEERING_ID}] steering by user at`);
      expect(text).toContain(STEERING_BODY);
    });

    it(`${name} states a miss instead of dropping an unknown id`, async () => {
      const text = await show({ id: "FN-259", commentIds: ["msg-phantom"] });
      expect(text).toContain("[msg-phantom] not found on this card");
    });

    it(`${name} renders no Comments section when no ids are requested`, async () => {
      const text = await show({ id: "FN-259" });
      expect(text).not.toContain("Comments:");
      expect(text).not.toContain(BODY);
      expect(text).toContain("PROMPT.md:")
    });
  }

  it("agrees across every agent lane about what one advertised id returns", async () => {
    const rendered = await Promise.all(
      Object.values(surfaces).map((show) => show({ id: "FN-259", commentIds: [COMMENT_ID, STEERING_ID] })),
    );
    for (const text of rendered) {
      expect(text).toContain(`[${COMMENT_ID}] comment by user at 2026-09-27T10:00:00.000Z:\n  ${BODY}`);
      expect(text).toContain(`[${STEERING_ID}] steering by user at 2026-09-27T10:10:00.000Z:\n  ${STEERING_BODY}`);
    }
    // The steering lane mirrors the unified row under the same id; parity means one line per id,
    // never the same body twice with two different labels.
    for (const text of rendered) {
      expect(text.match(new RegExp(`\\[${STEERING_ID}\\]`, "g"))).toHaveLength(1);
    }
  });
});

/*
The card lookup and the comment lookup share one try/catch. A board that cannot answer must therefore keep
the shape `read-path-store-failure.test.ts` pins for this tool — the shared retry guidance, flagged as an
error — and must never degrade into "not found", which would read as "this card and its comments do not
exist" and teach an agent to stop looking for steering that is really still there.
*/
describe("fn_task_show error semantics survive the comment read", () => {
  it("keeps an unreachable board reported as a retryable failure when comment ids are requested", async () => {
    const failing = { getTask: vi.fn(async () => { throw new Error("connection reset by peer"); }) } as unknown as TaskStore;
    const result = (await runSharedFactoryShow(failing, { id: "FN-259", commentIds: [COMMENT_ID] })) as {
      content: Array<{ text: string }>; isError?: boolean; details?: { code?: string };
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain(STORE_RETRY_GUIDANCE);
    expect(result.content[0]!.text.toLowerCase()).not.toContain("not found");
  });

  it("still calls a genuinely absent card absent when comment ids are requested", async () => {
    const absent = { getTask: vi.fn(async () => { throw new TaskNotFoundError("FN-259"); }) } as unknown as TaskStore;
    const result = (await runSharedFactoryShow(absent, { id: "FN-259", commentIds: [COMMENT_ID] })) as {
      content: Array<{ text: string }>; isError?: boolean;
    };
    expect(result.content[0]!.text).toContain("FN-259 not found");
    expect(result.isError).toBeUndefined();
  });
});
