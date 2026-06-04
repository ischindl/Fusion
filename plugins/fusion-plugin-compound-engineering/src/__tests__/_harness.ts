import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { Database } from "@fusion/core";
import type {
  CreateInteractiveAiSessionFactory,
  InteractiveAiSession,
  InteractiveAiSessionEvent,
  PluginContext,
} from "@fusion/core";

export interface TestHarness {
  db: Database;
  projectRoot: string;
  ctx: PluginContext;
  emitted: Array<{ event: string; data: unknown }>;
  close(): void;
}

/**
 * In-memory DB + a minimal route-style PluginContext whose `taskStore` exposes
 * `getDatabase()` / `getRootDir()` (the only surfaces the orchestrator uses) and
 * a recording `emitEvent` so tests can assert observable events.
 */
export function makeHarness(): TestHarness {
  const projectRoot = mkdtempSync(join(tmpdir(), "ce-session-test-"));
  const db = new Database(join(projectRoot, ".fusion"), { inMemory: true });
  db.init();

  const emitted: Array<{ event: string; data: unknown }> = [];

  const taskStore = {
    getDatabase: () => db,
    getRootDir: () => projectRoot,
  } as unknown as PluginContext["taskStore"];

  const ctx: PluginContext = {
    pluginId: "fusion-plugin-compound-engineering",
    taskStore,
    settings: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    emitEvent: (event: string, data: unknown) => {
      emitted.push({ event, data });
    },
  };

  return {
    db,
    projectRoot,
    ctx,
    emitted,
    close: () => db.close(),
  };
}

/**
 * A scripted fake interactive session: each prompt/answer advances a cursor and
 * the next `nextEvent()` yields the scripted event for that turn. Mirrors the
 * U4 seam tests' scripted fake.
 */
export function makeScriptedSession(script: InteractiveAiSessionEvent[]): InteractiveAiSession {
  let cursor = -1;
  return {
    prompt: vi.fn(async () => {
      cursor++;
    }),
    answer: vi.fn(async () => {
      cursor++;
    }),
    nextEvent: vi.fn(async () => {
      if (script.length === 0) {
        // An empty script is a test bug — surface it loudly rather than
        // silently returning undefined (which masks the mistake downstream).
        throw new Error("makeScriptedSession: empty script has no events to yield");
      }
      return script[Math.min(Math.max(cursor, 0), script.length - 1)];
    }),
    dispose: vi.fn(),
  };
}

/** A factory that returns the given scripted session. */
export function scriptedFactory(session: InteractiveAiSession): CreateInteractiveAiSessionFactory {
  return vi.fn(async () => ({ session, sessionFile: "/tmp/ce.json" }));
}

/** A session whose first turn never produces an event (forces a turn timeout). */
export function hangingSession(): InteractiveAiSession {
  return {
    prompt: vi.fn(async () => undefined),
    answer: vi.fn(async () => undefined),
    nextEvent: vi.fn(() => new Promise<InteractiveAiSessionEvent>(() => undefined)),
    dispose: vi.fn(),
  };
}
