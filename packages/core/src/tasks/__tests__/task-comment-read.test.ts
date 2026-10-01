/*
FNXC:CommentDelivery 2026-09-27-17:45 (RUFU-259):
Every lane that wakes an agent with a comment id must be able to hand back the body for that id, and
all of them render through this one module. These tests pin the read contract itself (the cross-surface
parity tests live in `packages/engine/src/__tests__/task-show-comment-read.test.ts`): bodies by id from
either comment lane, honest miss lines instead of silent drops, an explicit clipping marker instead of a
silent cut, and no change at all to a caller that asks for nothing.
*/
import { describe, expect, it } from "vitest";
import {
  MAX_COMMENT_LOOKUP_IDS,
  collectTaskCommentEntries,
  renderTaskCommentSection,
  resolveAdvertisedCommentIds,
} from "../task-comment-read.js";

function carrier(overrides: Record<string, unknown> = {}) {
  return {
    comments: [
      { id: "1758-dual", text: "please rebase first", author: "user", createdAt: "2026-09-27T10:00:00.000Z" },
      { id: "1758-agent", text: "pushed the fix", author: "agent", createdAt: "2026-09-27T10:05:00.000Z" },
    ],
    steeringComments: [
      { id: "1758-dual", text: "please rebase first", author: "user", createdAt: "2026-09-27T10:00:00.000Z" },
      { id: "1758-steer", text: "stop touching the lockfile", author: "user", createdAt: "2026-09-27T10:10:00.000Z" },
    ],
    ...overrides,
  } as never;
}

describe("collectTaskCommentEntries", () => {
  it("indexes both comment lanes and labels the steering lane so a steering id is not mistaken for a plain comment", () => {
    const entries = collectTaskCommentEntries(carrier());
    expect(entries.get("1758-agent")?.kind).toBe("comment");
    expect(entries.get("1758-steer")?.kind).toBe("steering");
    expect(entries.get("1758-dual")?.kind).toBe("steering");
  });

  it("returns an empty map for a card with no comments and for a missing card", () => {
    expect(collectTaskCommentEntries({} as never).size).toBe(0);
    expect(collectTaskCommentEntries(null as never).size).toBe(0);
  });
});

describe("renderTaskCommentSection", () => {
  it("renders nothing when no ids are requested, so an untouched call site keeps its old output", () => {
    expect(renderTaskCommentSection(carrier(), undefined)).toBe("");
    expect(renderTaskCommentSection(carrier(), [])).toBe("");
  });

  it("returns author, clock, and verbatim body for a requested unified comment", () => {
    const text = renderTaskCommentSection(carrier(), ["1758-agent"]);
    expect(text).toContain("Comments:");
    expect(text).toContain("[1758-agent] comment by agent at 2026-09-27T10:05:00.000Z:");
    expect(text).toContain("pushed the fix");
  });

  it("labels a steering id as steering, which is how the agent learns it is operator steering", () => {
    const text = renderTaskCommentSection(carrier(), ["1758-steer"]);
    expect(text).toContain("[1758-steer] steering by user at");
    expect(text).toContain("stop touching the lockfile");
  });

  it("answers an unknown id with an explicit miss instead of omitting it", () => {
    const text = renderTaskCommentSection(carrier(), ["msg-d3adbeef"]);
    expect(text).toContain("[msg-d3adbeef] not found on this card");
    expect(text).toContain("searched 2 comment(s), 2 steering comment(s)");
  });

  it("names withheld ids rather than silently dropping the overflow past the cap", () => {
    const ids = Array.from({ length: MAX_COMMENT_LOOKUP_IDS + 10 }, (_, index) => `1758-${index}`);
    const text = renderTaskCommentSection(carrier(), ids);
    // Every id inside the cap still gets its own line.
    expect(text).toContain("- [1758-0] not found on this card");
    expect(text).toContain("- [1758-19] not found on this card");
    // The overflow is reported as withheld, and the named ids stop at the notice's own bound.
    expect(text).toContain("10 requested id(s) withheld by the 20-id limit: [1758-20]");
    expect(text).toContain("+5 more");
    expect(text).not.toContain("[1758-29]");
  });

  it("clips an oversized body and says so, instead of truncating silently", () => {
    const huge = "x".repeat(5_000);
    const text = renderTaskCommentSection(carrier({
      comments: [{ id: "1758-huge", text: huge, author: "user", createdAt: "2026-09-27T10:00:00.000Z" }],
      steeringComments: [],
    }), ["1758-huge"]);
    expect(text).toContain("body clipped at 4000 of 5000 characters");
    expect(text).toContain("x".repeat(4_000));
    expect(text).not.toContain("x".repeat(4_001));
  });

  it("keeps a body that fits whole, character for character", () => {
    const text = renderTaskCommentSection(carrier({
      comments: [{ id: "1758-keep", text: "line one\nline two\ttabbed", author: "user", createdAt: "2026-09-27T10:00:00.000Z" }],
      steeringComments: [],
    }), ["1758-keep"]);
    expect(text).toContain("line one\n  line two\ttabbed");
  });
});

describe("resolveAdvertisedCommentIds", () => {
  it("keeps only ids a reader can actually resolve, which is what makes a wake delta honest", () => {
    expect(resolveAdvertisedCommentIds(carrier(), ["1758-steer", "msg-phantom"])).toEqual(["1758-steer"]);
  });

  it("returns nothing for a wake that advertised no ids", () => {
    expect(resolveAdvertisedCommentIds(carrier(), undefined)).toEqual([]);
    expect(resolveAdvertisedCommentIds(null as never, ["a"])).toEqual([]);
  });
});
