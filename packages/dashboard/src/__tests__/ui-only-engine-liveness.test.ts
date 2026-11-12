/**
 * RUFU-938 — a `--no-engine` dashboard must answer liveness truthfully.
 *
 * Measured in production 2026-11-12 in the split deployment the operator runs: a UI-only dashboard
 * host on one port beside a real engine host on another, over one shared database, same project.
 *
 *   GET :4040/api/health            -> engine: { available: false }     <- drew "AI engine is not running"
 *   GET :4040/api/engine/status     -> { connected:false, reason:"dashboard-only" }  <- drew "Run `fn serve`"
 *   GET :4040/api/projects/<id>/health -> status:"active", inFlightAgentCount: 1     <- the SAME process
 *
 * Both panels then advised stopping this server and running `pnpm local` / `fn dashboard`, which
 * would take down the engine currently serving the board. The cause was structural: both answers
 * began with `if (!engineManager) return <not live>` — the machine-level detection that already
 * existed sat *behind* that return, and the running-agent count that project health publishes was
 * computed *after* it.
 *
 * Every case below builds a server with NO `engineManager`, which is what the CLI's UI-only branch
 * passes (deliberately: a host with no engine runtime must not gain an engine-start surface). The
 * routes ride the in-memory `test-request` harness, so nothing binds a port — and port 4040 in
 * particular stays untouched.
 *
 * Both directions of the error are asserted, in both shapes:
 *   - no evidence at all  => the payload must stay not-live (a false "live" would hide the one banner
 *     that tells a genuinely engine-less operator what to do);
 *   - proven live         => the payload must stop saying unavailable.
 */
// @vitest-environment node

import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, TaskStore } from "@fusion/core";
import { createServer, resolveDashboardEngineAvailability } from "../server.js";
import { request } from "../test-request.js";

const PROJECT = "proj_split";

/*
Registry doubles for `project-store-resolver`. `getOrCreateProjectStore` throws on purpose: a liveness
answer that tried to open a project store — or, one step further, initialize a project — must fail the
suite loudly instead of succeeding by opening what it was only supposed to observe.
*/
const registry: { entries: Array<{ projectId: string; store: TaskStore }> } = { entries: [] };
const storeCounts: { count: number } = { count: 0 };

vi.mock("../project-store-resolver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../project-store-resolver.js")>();
  return {
    ...actual,
    listRegisteredProjectStores: vi.fn(() => registry.entries),
    // A store that is asked always answers a number; the "unknown" shape comes from having NO store
    // to ask (asserted at the payload seam), never from an invented exception.
    countRunningAgentsInStore: vi.fn(async () => storeCounts.count),
    countRunningAgentsInRegisteredProjectStores: vi.fn(async () => ({})),
    getOrCreateProjectStore: vi.fn(() => {
      throw new Error("LIVENESS_MUST_NOT_OPEN_A_PROJECT_STORE");
    }),
  };
});

/**
 * Registered-store double. A real registered store is an EventEmitter because route registrars attach
 * task listeners to every one of them, so the double has to be one too.
 */
function storeDouble(): TaskStore {
  return new EventEmitter() as unknown as TaskStore;
}

/** Central-registry double: the launch project is the default project, as in a `fn dashboard` boot. */
function coreDouble(defaultProjectId: string | undefined = PROJECT) {
  return {
    getDefaultProjectId: vi.fn(async () => defaultProjectId),
    getProject: vi.fn(async (id: string) => ({ id, status: "active" })),
  };
}

function presenceProbe(live: boolean | ((projectId: string) => boolean)) {
  return vi.fn(async (projectId: string) => (typeof live === "function" ? live(projectId) : live));
}

/** The minimal store a health/status route needs; same double family as the heap-ceiling suite. */
class MockStore extends EventEmitter {
  getRootDir(): string {
    return "/repo";
  }
  getFusionDir(): string {
    return "/repo/.fusion";
  }
  // Production-shaped backend seam: `createServer` probes the async layer and runs stale-AI-session
  // recovery through it, so the double answers the drizzle chain with an empty result set (the same
  // double shape as `dashboard-heap-ceiling-observability.test.ts`).
  getAsyncLayer = vi.fn(() => ({
    db: {
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({ returning: vi.fn(async () => []) })),
        })),
      })),
    },
    healthDb: {},
  }));
  getSettings = vi.fn(async () => this.getSettingsFast());
  getSettingsFast = vi.fn(async (): Promise<Settings> => ({ } as Settings));
  getTaskWorkflowSelection = vi.fn(() => undefined);
  getWorkflowDefinition = vi.fn(async () => undefined);
  getWorkflowSettingValues = vi.fn(() => ({}));
  getWorkflowSettingsProjectId = vi.fn(() => "default");
  getProjectScopedPluginMcpServers = vi.fn(async () => []);
  listTasks = vi.fn(async () => []);
  recordRunAuditEvent = vi.fn();
}

function uiOnlyServer(options: Record<string, unknown> = {}) {
  return createServer(new MockStore() as unknown as TaskStore, {
    noAuth: true,
    // The one thing the CLI's UI-only branch does not pass, and the whole subject of the card.
    ...options,
  } as never);
}

async function get(app: ReturnType<typeof createServer>, path: string) {
  const res = await request(app, "GET", path);
  return { status: res.status, body: res.body as Record<string, any> };
}

beforeEach(() => {
  registry.entries = [];
  storeCounts.count = 0;
});

describe("resolveDashboardEngineAvailability — the machine-level `engine.available`", () => {
  it("is true for an in-process engine, without asking anything else", async () => {
    const probe = presenceProbe(false);
    await expect(
      resolveDashboardEngineAvailability({ engine: {} as never, enginePresenceProbe: probe } as never),
    ).resolves.toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });

  it("keeps the manager-bearing answers byte-identical (desktop embedded local mode included)", async () => {
    // A manager that supports machine-level liveness means automation exists at the process level,
    // even with an empty owned-engine map — the RUFU-desktop behavior must not regress.
    await expect(
      resolveDashboardEngineAvailability({
        engineManager: { hasRunningEngine: () => false, getAllEngines: () => new Map() },
        enginePresenceProbe: presenceProbe(false),
      } as never),
    ).resolves.toBe(true);

    // A legacy manager double without that method keeps the historical owned-engine fallback.
    await expect(
      resolveDashboardEngineAvailability({ engineManager: { getAllEngines: () => new Map() } } as never),
    ).resolves.toBe(false);
    await expect(
      resolveDashboardEngineAvailability({
        engineManager: { getAllEngines: () => new Map([[PROJECT, {}]]) },
      } as never),
    ).resolves.toBe(true);
  });

  it("is true in a UI-only process whose project's engine is live on this machine", async () => {
    registry.entries = [{ projectId: PROJECT, store: storeDouble() }];
    const probe = presenceProbe(true);

    await expect(
      resolveDashboardEngineAvailability({ enginePresenceProbe: probe } as never),
    ).resolves.toBe(true);
    expect(probe.mock.calls.map(([id]) => id)).toContain(PROJECT);
  });

  it("asks about the project the host was launched for even before any project route opened a store", async () => {
    // The boot-window shape: no registered stores yet, so the candidate set comes from the central
    // default project id. Without this the first health polls would still read "engine not running".
    registry.entries = [];
    const probe = presenceProbe(true);

    await expect(
      resolveDashboardEngineAvailability({
        enginePresenceProbe: probe,
        centralCore: coreDouble() as never,
      } as never),
    ).resolves.toBe(true);
    expect(probe.mock.calls.map(([id]) => id)).toEqual([PROJECT]);
  });

  it("stays false with no manager, no candidate, and no probe call at all", async () => {
    registry.entries = [];
    const probe = presenceProbe(true);

    await expect(resolveDashboardEngineAvailability({} as never)).resolves.toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it("treats a hostile probe as no evidence, never as a live engine", async () => {
    registry.entries = [{ projectId: PROJECT, store: storeDouble() }];
    const probe = vi.fn(async () => {
      throw new Error("PROBE_MUST_NOT_FAIL_HEALTH");
    });

    await expect(
      resolveDashboardEngineAvailability({
        enginePresenceProbe: probe,
        centralCore: coreDouble() as never,
      } as never),
    ).resolves.toBe(false);
  });
});

/*
 * ONE full-server pair, for the wire shape only. Every state distinction lives at the narrow seams
 * above (`resolveDashboardEngineAvailability`) and in `engine-status-payload.test.ts`
 * (`buildEngineStatusPayload` with no `engineManager`); booting the whole route table to re-prove a
 * ladder decision would be a second opinion about the same code, and a much more expensive one.
 * What only a server boot can prove is that the two routes actually carry the new fields, and that
 * the start route still refuses.
 */
describe("the UI-only routes carry the manager-free answer end to end", () => {
  it("answers GET /api/health and GET /api/engine/status from live evidence on one server", async () => {
    registry.entries = [{ projectId: PROJECT, store: storeDouble() }];
    storeCounts.count = 1;
    const app = uiOnlyServer({ enginePresenceProbe: presenceProbe(true) });

    const health = await get(app, "/api/health");
    const status = await get(app, `/api/engine/status?projectId=${PROJECT}`);

    // The two false claims the operator read, both retracted by the same evidence.
    expect(health.status).toBe(200);
    expect(health.body.engine?.available).toBe(true);

    expect(status.status).toBe(200);
    expect(status.body.connected).toBe(true);
    expect(status.body.reason).toBe("externally-owned");
    expect(status.body.engineHandle).toBe(false);
    expect(status.body.runningAgentCount).toBe(1);
    // The competing advice: `canStart` true is exactly what makes a panel offer a start action.
    expect(status.body.canStart).toBe(false);
    expect(status.body.canResume).toBe(false);
  });

  it("keeps POST /api/engine/start refusing, naming the reason it actually measured", async () => {
    registry.entries = [{ projectId: PROJECT, store: storeDouble() }];
    storeCounts.count = 1;
    const live = uiOnlyServer({ enginePresenceProbe: presenceProbe(false) });

    const liveRes = await request(live, "POST", `/api/engine/start?projectId=${PROJECT}`);
    const liveBody = liveRes.body as Record<string, any>;

    expect(liveRes.status).toBe(409);
    expect(liveBody.reason).toBe("live-without-handle");
    expect(liveBody.status?.connected).toBe(true);

    // Same server shape, no evidence at all: the original refusal must survive the change intact.
    registry.entries = [];
    storeCounts.count = 0;
    const idle = uiOnlyServer({ enginePresenceProbe: presenceProbe(false) });
    const idleRes = await request(idle, "POST", `/api/engine/start?projectId=${PROJECT}`);
    const idleBody = idleRes.body as Record<string, any>;

    expect(idleRes.status).toBe(409);
    expect(idleBody.reason).toBe("dashboard-only");
    expect(idleBody.error).toBe("Engine manager is unavailable");
  });
});
