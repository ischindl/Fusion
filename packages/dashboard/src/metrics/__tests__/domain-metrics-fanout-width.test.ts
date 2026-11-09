// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  createDomainSampler,
  createMetricsSampler,
  defaultPgStatsReader,
  type MetricFamily,
} from "../index.js";
import type { DomainSamplerInit } from "../domain-sampler.js";
import { createDashboardDomainRegistry, createServedProjectStoreRegistry } from "../served-project-stores.js";

/**
 * RUFU-911 domain fan-out WIDTH ratchet.
 *
 * The metrics view reported `fusion_domain_projects_total 1` on a board with 25 visible projects, one
 * `fusion_domain_project_running_agents` series instead of one per project, and
 * `fusion_domain_postgres_queries_per_second 0` against a provably busy database. Every family was
 * PRESENT in the exposition the whole time — presence was satisfied exactly when the numbers were
 * wrong — so this suite asserts WIDTH and the two distinct empty-render shapes, never mere presence.
 *
 * The two shapes it reproduces (they are one cause, not two defects):
 *   Shape A — registered scalar, never updated: a label-free family always pushes one sample built
 *     from `state.*`, so it emits its INITIAL value (0) forever.
 *   Shape B — registered family, zero series: a label-cardinality family renders HELP/TYPE from an
 *     empty record and NO sample line, so `grep '^fusion_[a-z_]*agent'` finds nothing while the
 *     family is still registered.
 *
 * Why the width assertion is the ratchet: `metricsSampler.start()` is one call site arming the
 * runtime, domain and retention ticks together, so no launcher/respawn-dependent init exists. The
 * ticks ran; they read `storeCache`, the dashboard's SECONDARY store cache, which holds neither the
 * default in-process store nor an engine-manager store. A width assertion over the real server wiring
 * is what a presence assertion could not do.
 *
 * `createServer` is deliberately NOT imported: it drags the whole plugin-runtime graph (an unbuilt
 * workspace package) into a metrics unit test. The wiring it would have exercised is covered through
 * `createDashboardDomainRegistry`, the exact function `server.ts` calls to build this registry.
 */

/** Families the domain sampler is required to render — the ratchet's closed set. */
const REQUIRED_DOMAIN_FAMILIES = [
  "fusion_domain_postgres_queries_per_second",
  "fusion_domain_projects_total",
  "fusion_domain_projects_active",
  "fusion_domain_projects_idle",
  "fusion_domain_project_running_agents",
  "fusion_domain_board_tasks",
  "fusion_postgres_pool_backends",
  "fusion_postgres_pool_max",
];

function familyOf(families: MetricFamily[], name: string): MetricFamily {
  const found = families.find((f) => f.name === name);
  expect(found, `domain family ${name} must always be rendered`).toBeDefined();
  return found!;
}

/** A store double for the fan-out: N running agents and one card in `todo`. */
function countingStore(runningAgents: number) {
  return {
    listTasks: async () => [{ column: "todo" }],
    __runningAgents: runningAgents,
  };
}

const FLEET_SIZE = 25;

/** 25 engine-manager-backed projects — the fleet width the operator could actually see. */
function engineManagerFleet(projectIds: string[], runningAgents = 2) {
  const engines = new Map(
    projectIds.map((projectId) => [
      projectId,
      { getTaskStore: () => countingStore(runningAgents) },
    ]),
  );
  return { getAllEngines: () => engines, getEngine: (id: string) => engines.get(id) };
}

describe("served-project-store registry (RUFU-911 fan-out source)", () => {
  it("covers every engine-backed project, not the one project the secondary cache happens to hold", () => {
    const projectIds = Array.from({ length: FLEET_SIZE }, (_, i) => `proj_${i}`);
    // The pre-fix world: the secondary cache holds exactly ONE of the 25 projects.
    const registry = createServedProjectStoreRegistry({
      engineManager: engineManagerFleet(projectIds),
      listRegisteredStores: () => [{ projectId: projectIds[0], store: countingStore(0) }],
    });

    const served = registry();
    expect(served).toHaveLength(FLEET_SIZE);
    expect(new Set(served.map((entry) => entry.projectId))).toEqual(new Set(projectIds));
  });

  it("prefers the engine-manager store over a stale registered store for the same project", () => {
    const engineStore = countingStore(7);
    const staleStore = countingStore(0);
    const registry = createServedProjectStoreRegistry({
      engineManager: {
        getAllEngines: () => new Map([["proj_a", { getTaskStore: () => engineStore }]]),
      },
      listRegisteredStores: () => [{ projectId: "proj_a", store: staleStore }],
    });

    const served = registry();
    expect(served).toHaveLength(1);
    expect(served[0].store).toBe(engineStore);
  });

  it("adds the default in-process store under the central default id, exactly once", async () => {
    const defaultStore = countingStore(3);
    const registry = createServedProjectStoreRegistry({
      engineManager: engineManagerFleet(["proj_0"]),
      listRegisteredStores: () => [],
      defaultStore,
      resolveDefaultProjectId: async () => "proj_default",
    });

    // The default id is resolved off-thread so the tick stays synchronous: the first read kicks the
    // resolve and cannot yet name the default project, a later read includes it. That two-tick shape
    // is the contract, so the test walks it rather than assuming the id is free at construction.
    expect(registry().map((entry) => entry.projectId)).toEqual(["proj_0"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const served = registry();

    expect(served.map((entry) => entry.projectId).sort()).toEqual(["proj_0", "proj_default"]);
    expect(served.filter((entry) => entry.projectId === "proj_default")).toHaveLength(1);
    expect(served.find((entry) => entry.projectId === "proj_default")!.store).toBe(defaultStore);
  });

  it("never invents a project it cannot observe and survives a throwing default-id resolver", async () => {
    const registry = createServedProjectStoreRegistry({
      engineManager: { getAllEngines: () => new Map([["proj_a", {}]]) },
      listRegisteredStores: () => [{ projectId: "", store: countingStore(1) }],
      resolveDefaultProjectId: async () => {
        throw new Error("central registry unavailable");
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    // An engine with no store and an empty project id are both unrepresentable, not zero-counted.
    expect(registry()).toEqual([]);
  });
});

describe("domain sampler fan-out width", () => {
  function fleetSampler(overrides: Partial<DomainSamplerInit> = {}) {
    const projectIds = Array.from({ length: FLEET_SIZE }, (_, i) => `proj_${i}`);
    const engines = new Map(
      projectIds.map((projectId) => [projectId, { getTaskStore: () => countingStore(2) }]),
    );
    // Assembled through `createDashboardDomainRegistry` — the SAME function `server.ts` calls, so a
    // regression that drops the injected registry fails here instead of rendering a quiet panel.
    const sampler = createDomainSampler({
      registeredStores: createDashboardDomainRegistry({
        engineManager: { getAllEngines: () => engines },
        listRegisteredStores: () => [],
      }),
      countAgentsInStore: async (store) => (store as { __runningAgents: number }).__runningAgents,
      listTasksInStore: async (store) => (store as { listTasks: () => Promise<{ column: string }[]> }).listTasks(),
      ...overrides,
    });
    return { sampler, projectIds };
  }

  it("a tick with live data yields 25 project-labelled agent series and a non-zero agent count", async () => {
    const { sampler, projectIds } = fleetSampler();
    await sampler.sampleDomain();
    const families = sampler.buildSnapshot();

    const projects = familyOf(families, "fusion_domain_projects_total");
    // The exact live lie: this read 1 against 25 visible projects.
    expect(projects.samples).toHaveLength(1);
    expect(projects.samples[0].value).toBe(FLEET_SIZE);

    const agents = familyOf(families, "fusion_domain_project_running_agents");
    expect(agents.samples).toHaveLength(FLEET_SIZE);
    expect(new Set(agents.samples.map((s) => s.labelValues?.[0]))).toEqual(new Set(projectIds));
    // Non-zero agent count, per project — not one global line.
    expect(agents.samples.every((s) => s.value === 2)).toBe(true);
    expect(familyOf(families, "fusion_domain_projects_active").samples[0].value).toBe(FLEET_SIZE);
  });

  it("Shape B reproduction: an empty registry renders the agent family with HELP/TYPE and ZERO series", async () => {
    const sampler = createDomainSampler({
      registeredStores: () => [],
    });
    await sampler.sampleDomain();
    const families = sampler.buildSnapshot();

    const agents = familyOf(families, "fusion_domain_project_running_agents");
    expect(agents.samples).toHaveLength(0);
    // Width, not presence: this is what `grep '^fusion_[a-z_]*agent'` returned — nothing.
    const rendered = agents.samples
      .map((s) => `${agents.name}{project="${s.labelValues?.[0]}"} ${s.value}`)
      .join("\n");
    expect(rendered).toBe("");
    expect(familyOf(families, "fusion_domain_projects_total").samples[0].value).toBe(0);
  });

  it("Shape A reproduction: the PG scalar stays registered at its initial 0 when the registry is empty", async () => {
    const emptyRegistry = () => [];
    const sampler = createDomainSampler({ registeredStores: emptyRegistry });

    await sampler.samplePgRate();
    await sampler.samplePgRate();
    await sampler.samplePgRate();

    // Registered-and-pinned, not missing: three ticks, still the constructor's 0.
    expect(sampler.state.pgQueriesPerSecond).toBe(0);
    const rate = familyOf(sampler.buildSnapshot(), "fusion_domain_postgres_queries_per_second");
    expect(rate.samples).toHaveLength(1);
    expect(rate.samples[0].value).toBe(0);
  });

  it("the PG probe reads the sampler's own registry, so a real fleet yields a real rate", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.parse("2026-11-09T18:00:00Z"));
      let commit = 1000;
      const store = {
        getAsyncLayer: () => ({
          db: {
            execute: async () => {
              commit += 500;
              return [{ datname: "fusion", xact_commit: commit, xact_rollback: 0 }];
            },
          },
        }),
      };
      const reader = defaultPgStatsReader(() => [{ projectId: "proj_0", store }]);

      await reader();
      vi.advanceTimersByTime(1000);
      const rate = await reader();
      expect(rate).not.toBeNull();
      // Non-zero proves the probe found a store; the pre-fix probe found none and reported 0 forever.
      expect(rate!.reduce((sum, row) => sum + row.xactCommit, 0)).toBeGreaterThan(1000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a throwing per-store read degrades to zero agents without losing the fleet's other projects", async () => {
    const engines = new Map<string, { getTaskStore: () => unknown }>([
      ["proj_good", { getTaskStore: () => countingStore(4) }],
      ["proj_bad", { getTaskStore: () => ({ listTasks: async () => { throw new Error("pool gone"); } }) }],
    ]);
    const sampler = createDomainSampler({
      registeredStores: createServedProjectStoreRegistry({
        engineManager: { getAllEngines: () => engines },
        listRegisteredStores: () => [],
      }),
      countAgentsInStore: async (store) =>
        (store as { __runningAgents?: number }).__runningAgents ?? 0,
      listTasksInStore: async (store) =>
        (store as { listTasks: () => Promise<{ column: string }[]> }).listTasks(),
    });
    await sampler.sampleDomain();

    // Both projects stay counted: a failing read zeroes that project, it never drops the project.
    expect(familyOf(sampler.buildSnapshot(), "fusion_domain_projects_total").samples[0].value).toBe(2);
  });
});

describe("served exposition and the server's own wiring", () => {
  it("registers every domain family the sampler defines", () => {
    // Rendered by the orchestrator - the same `render()` closure that answers `GET /metrics`.
    const body = createMetricsSampler().render();
    for (const name of REQUIRED_DOMAIN_FAMILIES) {
      expect(body, `${name} must be registered`).toContain(`# TYPE ${name} gauge`);
    }
  });

  it("assembles the server's own registry across 25 engine-backed projects (width, not presence)", () => {
    const projectIds = Array.from({ length: FLEET_SIZE }, (_, i) => `proj_${i}`);
    // Exactly the dependency shape `createServer` passes: an engine manager, the secondary cache that
    // holds only one of them, and no central default id yet.
    const registry = createDashboardDomainRegistry({
      engineManager: engineManagerFleet(projectIds),
      listRegisteredStores: () => [{ projectId: projectIds[0], store: countingStore(0) }],
    });

    const served = registry();
    expect(served).toHaveLength(FLEET_SIZE);
    expect(served.map((entry) => entry.projectId).sort()).toEqual([...projectIds].sort());
  });

  it("renders one agent sample LINE per project, so 25 projects never collapse into one row", async () => {
    const projectIds = Array.from({ length: FLEET_SIZE }, (_, i) => `proj_${i}`);
    const engines = new Map(
      projectIds.map((projectId) => [projectId, { getTaskStore: () => countingStore(2) }]),
    );
    const sampler = createDomainSampler({
      registeredStores: createDashboardDomainRegistry({
        engineManager: { getAllEngines: () => engines },
        listRegisteredStores: () => [],
      }),
      countAgentsInStore: async (store) => (store as { __runningAgents: number }).__runningAgents,
      listTasksInStore: async (store) =>
        (store as { listTasks: () => Promise<{ column: string }[]> }).listTasks(),
    });
    await sampler.sampleDomain();

    // The width claim stated as rendered lines, which is what an operator's panel actually reads.
    const lines = familyOf(sampler.buildSnapshot(), "fusion_domain_project_running_agents").samples.map(
      (s) => `fusion_domain_project_running_agents{project="${s.labelValues?.[0]}"} ${s.value}`,
    );
    expect(lines).toHaveLength(FLEET_SIZE);
    expect(new Set(lines).size).toBe(FLEET_SIZE);
    expect(sampler.state.projectCounts.total).toBe(FLEET_SIZE);
  });
});
