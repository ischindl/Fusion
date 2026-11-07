import { afterEach, describe, expect, it } from "vitest";
import {
  recallSearchCandidateWindow,
  RECALL_SEARCH_CANDIDATE_WINDOW_DEFAULT,
  searchRecall,
} from "../memory/recall/recall-store.js";
import { RECALL_SEARCH_MAX_LIMIT } from "../memory/recall/recall-search.js";

/*
FNXC:MemoryRecall 2026-11-07-09:47 (RUFU-871):
`searchRecall` used to SELECT every recall row of the project and apply the caller's limit afterwards in
JavaScript. One project holds 32,578 rows / 14 MB of `content`, so one `memory search` hydrated all of it —
inside the process that also hosts every engine lane — and then tokenized every content for keyword scoring.
The bound must live in the SQL, so the test asserts on the query's limit rather than on the returned hits:
a JS-side slice would keep the bug and still pass a result-shape assertion.
*/

function row(id: string, content: string, tags: string[] = [], createdAt = "2026-01-01T00:00:00.000Z") {
  return {
    id,
    projectId: "proj-1",
    kind: "note",
    content,
    contentHash: `hash-${id}`,
    source: "manual",
    tags,
    graphNodeIds: [],
    createdAt,
    updatedAt: createdAt,
  };
}

function fakeDb(rows: unknown[]) {
  const sent: Array<{ limit?: number }> = [];
  const db = {
    select: () => {
      const rec: { limit?: number } = {};
      sent.push(rec);
      const chain: Record<string, unknown> = {
        from: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: (n: number) => {
          rec.limit = n;
          return chain;
        },
        then: (resolve: (value: unknown[]) => void) => resolve(rows),
      };
      return chain;
    },
  };
  return { db, sent };
}

const layerFor = (rows: unknown[]) => ({ projectId: "proj-1", db: fakeDb(rows).db });

describe("recall search bounds its candidate read in SQL (RUFU-871)", () => {
  const saved = process.env.FUSION_RECALL_CANDIDATE_WINDOW;
  afterEach(() => {
    if (saved === undefined) delete process.env.FUSION_RECALL_CANDIDATE_WINDOW;
    else process.env.FUSION_RECALL_CANDIDATE_WINDOW = saved;
  });

  it("sends a LIMIT to the candidate read instead of hydrating the whole table", async () => {
    const { db, sent } = fakeDb([row("a", "heap growth in the dashboard")]);
    await searchRecall({ projectId: "proj-1", db } as never, "heap");

    expect(sent).toHaveLength(1);
    expect(sent[0].limit).toBe(RECALL_SEARCH_CANDIDATE_WINDOW_DEFAULT);
  });

  it("keeps keyword hits and the tag filter working on the windowed set", async () => {
    const { db } = fakeDb([
      row("a", "heap growth in the dashboard", ["memory"]),
      row("b", "unrelated note about scheduling", ["memory"]),
      row("c", "heap leak in another lane", ["other"]),
    ]);

    const hits = await searchRecall({ projectId: "proj-1", db } as never, "heap", { tags: ["memory"] });

    expect(hits.mode).toBe("keyword");
    expect(hits.hits.map((h) => h.record.id)).toEqual(["a"]);
  });

  it("never lets the window fall below what the shared limit clamp can request", () => {
    process.env.FUSION_RECALL_CANDIDATE_WINDOW = "1";
    expect(recallSearchCandidateWindow()).toBe(RECALL_SEARCH_MAX_LIMIT);

    process.env.FUSION_RECALL_CANDIDATE_WINDOW = "not-a-number";
    expect(recallSearchCandidateWindow()).toBe(RECALL_SEARCH_CANDIDATE_WINDOW_DEFAULT);
  });

  it("asks for the operator-raised window when one is configured", async () => {
    process.env.FUSION_RECALL_CANDIDATE_WINDOW = "5000";
    const { db, sent } = fakeDb([]);

    await searchRecall({ projectId: "proj-1", db } as never, "anything", { limit: 50 });

    expect(sent[0].limit).toBe(5_000);
  });
});
