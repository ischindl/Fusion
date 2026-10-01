import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";
import enAppCatalog from "../../../../../i18n/locales/en/app.json";
import { CHAT_IN_FLIGHT_GENERATION_STALE_MS } from "@fusion/core/chat-liveness";
import {
  CHAT_LIVENESS_I18N_KEYS,
  chatLivenessLabel,
  chatSessionLiveness,
  type ChatSessionLivenessSource,
} from "../chatLiveness";

/*
FNXC:ChatSidebarLiveness 2026-09-24-05:55 (RUFU-220):
The sidebar row is the operator's only view of an in-flight generation, so the projection that turns
a claim into a label is pinned here case by case. The precedence rules mirror core's classifier (the
same one the engine's reclaim sweep delegates to); what this file owns is the DASHBOARD contract:
when a tag exists at all, what it says, and that an unprovable age never becomes an accusation.

The age cases pass an explicit `nowMs` rather than depending on wall-clock, so the shared floor is
tested at its exact boundary.
*/

const NOW = Date.parse("2026-09-23T12:00:00.000Z");
const MINUTE = 60_000;

function row(overrides: Partial<ChatSessionLivenessSource> = {}): ChatSessionLivenessSource {
  return {
    inFlightGeneration: undefined,
    isGenerating: false,
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function claim(overrides: Record<string, unknown> = {}) {
  // `status: "generating"` is the durable server claim; the classifier reads no claim at all unless
  // it is present, so every fixture here states it the way the REST row and SSE payload do.
  return {
    status: "generating",
    startedAt: new Date(NOW - MINUTE).toISOString(),
    ...overrides,
  } as ChatSessionLivenessSource["inFlightGeneration"];
}

type RecordedCall = { key: string; fallback: string; resolved: string };

/** Recording `t` that resolves like i18next's inline-default path: interpolate the fallback. */
function makeT() {
  const calls: RecordedCall[] = [];
  const t = ((key: string, arg?: unknown, opts?: unknown) => {
    let fallback: string;
    let interpolation: Record<string, unknown> | undefined;
    if (typeof arg === "string") {
      fallback = arg;
      interpolation = (opts as Record<string, unknown> | undefined) ?? undefined;
    } else if (arg && typeof arg === "object") {
      interpolation = arg as Record<string, unknown>;
      fallback = typeof (arg as { defaultValue?: unknown }).defaultValue === "string"
        ? ((arg as { defaultValue: string }).defaultValue)
        : key;
    } else {
      fallback = key;
    }
    let resolved = fallback;
    if (interpolation) {
      for (const [name, value] of Object.entries(interpolation)) {
        resolved = resolved.split(`{{${name}}}`).join(String(value));
      }
    }
    calls.push({ key, fallback, resolved });
    return resolved;
  }) as unknown as TFunction<"app">;
  return { t, calls, keys: () => calls.map((c) => c.key) };
}

describe("chatSessionLiveness — when a tag exists at all", () => {
  it("renders nothing for a row without an in-flight claim, even while the client is generating", () => {
    // Control for the whole feature: the pre-change sidebar must stay byte-identical for rows the
    // server holds no claim about, and a session with no claim is NOT "stale".
    expect(chatSessionLiveness(row(), NOW)).toBeNull();
    expect(chatSessionLiveness(row({ isGenerating: true }), NOW)).toBeNull();
    expect(chatSessionLiveness(row({ inFlightGeneration: null }), NOW)).toBeNull();
  });

  it("renders nothing when a completed claim survived, whatever the client flag says", () => {
    expect(chatSessionLiveness(
      row({ inFlightGeneration: claim({ startedAt: new Date(NOW - 90 * MINUTE).toISOString(), status: "completed" }) }),
      NOW,
    )).toBeNull();
  });

  it("labels a provably-live claim Generating", () => {
    const liveness = chatSessionLiveness(row({ inFlightGeneration: claim() }), NOW);
    expect(liveness).not.toBeNull();
    expect(liveness!.kind).toBe("generating");
    expect(liveness!.ageMs).toBe(MINUTE);
  });

  it("keeps the sweep's inclusivity: the floor itself is still live, one millisecond past it is stale", () => {
    const atFloor = chatSessionLiveness(
      row({ inFlightGeneration: claim({ startedAt: new Date(NOW - CHAT_IN_FLIGHT_GENERATION_STALE_MS).toISOString() }) }),
      NOW,
    );
    const pastFloor = chatSessionLiveness(
      row({ inFlightGeneration: claim({ startedAt: new Date(NOW - CHAT_IN_FLIGHT_GENERATION_STALE_MS - 1).toISOString() }) }),
      NOW,
    );
    expect(atFloor!.kind).toBe("generating");
    expect(pastFloor!.kind).toBe("stale-pending-reclaim");
  });

  it("lets the proven age outrank a live-looking client flag", () => {
    // RN220-A: `isGenerating === true` is the client's optimistic view. A claim past the floor is
    // the server's durable statement, so the tag must say stale, not hide behind the client flag.
    const liveness = chatSessionLiveness(
      row({
        isGenerating: true,
        inFlightGeneration: claim({ startedAt: new Date(NOW - CHAT_IN_FLIGHT_GENERATION_STALE_MS - 1).toISOString() }),
      }),
      NOW,
    );
    expect(liveness!.kind).toBe("stale-pending-reclaim");
  });

  it("never turns an unprovable age into an accusation", () => {
    // Neither the claim nor the row carries a readable timestamp, so no age can be computed at all.
    const unprovable = claim({ startedAt: "not-a-date" });
    // Live enough to say so while the client reports a generation...
    expect(chatSessionLiveness(row({ updatedAt: "", isGenerating: true, inFlightGeneration: unprovable }), NOW)!.kind).toBe("generating");
    // ...and silent otherwise. Stale is a claim about the server, which an unreadable timestamp cannot support.
    expect(chatSessionLiveness(row({ updatedAt: "", inFlightGeneration: unprovable }), NOW)).toBeNull();
    expect(chatSessionLiveness(row({ updatedAt: "", isGenerating: false, inFlightGeneration: unprovable }), NOW)).toBeNull();
  });

  it("falls back to the row's updatedAt when the claim carries no timestamp", () => {
    const old = chatSessionLiveness(
      row({
        updatedAt: new Date(NOW - CHAT_IN_FLIGHT_GENERATION_STALE_MS - 5 * MINUTE).toISOString(),
        inFlightGeneration: claim({ startedAt: undefined }),
      }),
      NOW,
    );
    expect(old!.kind).toBe("stale-pending-reclaim");
  });

  it("treats a future-dated claim as live, never stale", () => {
    const liveness = chatSessionLiveness(
      row({ inFlightGeneration: claim({ startedAt: new Date(NOW + 10 * MINUTE).toISOString() }) }),
      NOW,
    );
    expect(liveness!.kind).toBe("generating");
  });
});

describe("chatSessionLiveness — the wall-clock seam", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW + CHAT_IN_FLIGHT_GENERATION_STALE_MS + 10 * MINUTE);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the wall clock by default and lets an explicit nowMs win over it", () => {
    // The default argument is why the faked-Date idiom drives this classifier at all: it reads wall
    // time, which the idiom controls, rather than a monotonic clock it cannot move.
    const session = row({ inFlightGeneration: claim() });
    // Faked now is floor+10min past the claim start, so the unaided call must report stale.
    expect(chatSessionLiveness(session)!.kind).toBe("stale-pending-reclaim");
    // The explicit seam used by the DOM test's fixed-clock cases: same row, live at `NOW`.
    expect(chatSessionLiveness(session, NOW)!.kind).toBe("generating");
    expect(chatSessionLiveness(session, NOW)!.ageMs).toBe(MINUTE);
  });
});

describe("chatSessionLiveness — copy and registered keys", () => {
  it("names the state and the shared recovery window in the tooltip", () => {
    const { t } = makeT();
    const liveness = chatSessionLiveness(
      row({ inFlightGeneration: claim({ startedAt: new Date(NOW - CHAT_IN_FLIGHT_GENERATION_STALE_MS - MINUTE).toISOString() }) }),
      NOW,
      t,
    )!;
    const minutes = Math.round(CHAT_IN_FLIGHT_GENERATION_STALE_MS / MINUTE);
    expect(liveness.title).toContain("Stale");
    // The window travels from core's constant, so the sentence can never promise a different
    // recovery window than the sweeper applies.
    expect(liveness.title).toContain(String(minutes));
  });

  it("asks for exactly the three registered keys and no raw key strings", () => {
    const { t, calls } = makeT();
    chatSessionLiveness(row({ inFlightGeneration: claim() }), NOW, t);
    chatSessionLiveness(
      row({ inFlightGeneration: claim({ startedAt: new Date(NOW - CHAT_IN_FLIGHT_GENERATION_STALE_MS - 1).toISOString() }) }),
      NOW,
      t,
    );
    expect(calls.map((c) => c.key).sort()).toEqual([
      CHAT_LIVENESS_I18N_KEYS.generating,
      CHAT_LIVENESS_I18N_KEYS.stale,
      CHAT_LIVENESS_I18N_KEYS.title,
      CHAT_LIVENESS_I18N_KEYS.title,
    ].sort());
    // An unresolved key would surface as the key itself; every resolution carries real copy.
    for (const call of calls) expect(call.resolved).not.toBe(call.key);
  });

  it("keeps every untranslated fallback byte-identical to the en catalog", () => {
    // The catalog value wins at runtime, so a diverging inline default is invisible drift in the
    // en build and a raw key in a language whose entry is missing.
    // Keys are namespace-prefixed ("chat.generating") while the catalog nests them, so resolve the
    // dotted path instead of indexing the root.
    const resolve = (path: string): unknown =>
      path.split(".").reduce<unknown>((node, part) => (node && typeof node === "object"
        ? (node as Record<string, unknown>)[part]
        : undefined), enAppCatalog);
    expect(resolve(CHAT_LIVENESS_I18N_KEYS.generating)).toBe(chatLivenessLabel("generating"));
    expect(resolve(CHAT_LIVENESS_I18N_KEYS.stale)).toBe(chatLivenessLabel("stale-pending-reclaim"));
    for (const key of Object.values(CHAT_LIVENESS_I18N_KEYS)) {
      const value = resolve(key);
      expect(typeof value, key).toBe("string");
      expect((value as string).length, key).toBeGreaterThan(0);
      // The tooltip interpolates its state and its window; a translation that drops a placeholder
      // would silently lose the recovery window from the sentence.
      if (key === CHAT_LIVENESS_I18N_KEYS.title) {
        expect(value as string).toContain("{{label}}");
        expect(value as string).toContain("{{minutes}}");
      }
    }
  });

  it("refuses an unknown kind instead of rendering a raw key", () => {
    expect(() => chatLivenessLabel("unexpected" as never)).toThrow(/unexpected/);
  });
});
