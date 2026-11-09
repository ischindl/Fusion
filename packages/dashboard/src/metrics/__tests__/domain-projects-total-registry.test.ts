// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  createDomainSampler,
  REGISTRY_CENSUS_BOUND_MS,
  resolveProjectPopulation,
  type DomainSamplerInit,
} from "../domain-sampler.js";
import { createRegisteredProjectIdReader } from "../served-project-stores.js";
import type { MetricFamily } from "../prometheus-text.js";

/**
 * RUFU-912 project-population ratchet: `projects_{total,active,idle}` count PROJECTS, not open stores.
 *
 * RUFU-911 widened the fan-out to every already-open store, which fixed the `total 1` vs 25-visible
 * reading. It did not fix the population, because stores warm lazily. Measured on the live deploy that
 * shipped RUFU-911 (pid 4107433, HEAD a0f6fbc391): right after start
 * `fusion_domain_projects_total` was 3, about three minutes later it was 11, and `central.projects`
 * held 25 rows the whole time; `^fusion_domain_project_running_agents{` grew from 3 to 11 lines in
 * step. That is the failure mode this suite pins — a gauge that is neither missing nor wrong-constant
 * but DRIFTS toward the truth while an operator watches it, which reads as a live system.
 *
 * The ratchet is therefore stated as two facts, which together are the whole contract:
 *   1. with one store open and 25 registered projects, `projects_total` is 25 on the FIRST tick;
 *   2. opening a second store does not change it.
 * A warming source fails fact 1 or fact 2; only a registry census can hold both.
 *
 * `createServer` is deliberately not imported — it drags the whole plugin-runtime graph into a metrics
 * unit test, for the same reason RUFU-911's width suite gives. The census wiring is covered through
 * `createRegisteredProjectIdReader`, the exact factory `server.ts` calls.
 */

const REGISTERED = Array.from({ length: 25 }, (_, i) => `proj_${i}`);

function familyOf(families: MetricFamily[], name: string): MetricFamily {
  const found = families.find((f) => f.name === name);
  expect(found, `domain family ${name} must always be rendered`).toBeDefined();
  return found!;
}

function gauge(families: MetricFamily[], name: string): number {
  const family = familyOf(families, name);
  expect(family.samples, `${name} renders exactly one scalar sample`).toHaveLength(1);
  return family.samples[0].value;
}

/** A store double: `running` agents and one card, so a cold project and a busy one are distinguishable. */
function store(running: number) {
  return { listTasks: async () => [{ column: "todo" }], __runningAgents: running };
}

function registryOf(entries: Array<{ projectId: string; store: unknown }>): DomainSamplerInit {
  return {
    registeredStores: () => entries,
    countAgentsInStore: async (s: unknown) => (s as { __runningAgents: number }).__runningAgents ?? 0,
    listTasksInStore: async (s: unknown) =>
      (s as { listTasks: () => Promise<Array<{ column: string }>> }).listTasks(),
  };
}

/** The census the sampler consumes: the registry's project ids, exactly as the server's reader maps them. */
const censusOf = (ids: string[]) => async () => ids;

describe("projects_total counts registered projects, not open stores", () => {
  it("cold-start shape: ONE open store against 25 registered projects reports 25 on the first tick", async () => {
    // This is the exact live shape that produced 3: a fresh process whose stores have not warmed yet.
    const sampler = createDomainSampler({
      ...registryOf([{ projectId: "proj_0", store: store(1) }]),
      registeredProjectIds: censusOf(REGISTERED),
    });

    await sampler.sampleDomain();

    // Pre-fix this read 1 (and 3 on the operator's panel): the count of stores, not of projects.
    expect(gauge(sampler.buildSnapshot(), "fusion_domain_projects_total")).toBe(REGISTERED.length);
  });

  it("opening a second store does NOT change projects_total — the drift the operator watched live", async () => {
    // The live panel went 3 -> 11 as stores opened. A census-backed gauge must be inert to store warmth.
    const open = [
      { projectId: "proj_0", store: store(0) },
      { projectId: "proj_1", store: store(0) },
    ];
    let served = open.slice(0, 1);
    const sampler = createDomainSampler({
      ...registryOf([]),
      registeredStores: () => served,
      registeredProjectIds: censusOf(REGISTERED),
    });

    await sampler.sampleDomain();
    const afterFirst = gauge(sampler.buildSnapshot(), "fusion_domain_projects_total");
    expect(afterFirst).toBe(REGISTERED.length);

    served = open;
    await sampler.sampleDomain();
    expect(gauge(sampler.buildSnapshot(), "fusion_domain_projects_total")).toBe(afterFirst);

    // Closing every store is equally inert: the fleet does not stop existing when nothing is warm.
    served = [];
    await sampler.sampleDomain();
    expect(gauge(sampler.buildSnapshot(), "fusion_domain_projects_total")).toBe(REGISTERED.length);
  });

  it("active and idle are defined against the same population, so total == active + idle always", async () => {
    // 25 registered, 2 warm: one running an agent, one measured idle. 23 have no store open at all.
    const sampler = createDomainSampler({
      ...registryOf([
        { projectId: "proj_0", store: store(2) },
        { projectId: "proj_1", store: store(0) },
      ]),
      registeredProjectIds: censusOf(REGISTERED),
    });

    await sampler.sampleDomain();
    const families = sampler.buildSnapshot();

    const total = gauge(families, "fusion_domain_projects_total");
    const active = gauge(families, "fusion_domain_projects_active");
    const idle = gauge(families, "fusion_domain_projects_idle");

    expect(active).toBe(1);
    // idle is the remainder of the REGISTERED population, so the 23 cold projects are idle-by-definition
    // here, which is why the help text refuses to call idle a statement that a project is parked.
    expect(idle).toBe(total - active);
    expect(total).toBe(REGISTERED.length);
    expect(total).toBe(active + idle);
  });

  it("a registered project that is not running stays absent from the agent series, and the help text says so", async () => {
    const sampler = createDomainSampler({
      ...registryOf([{ projectId: "proj_0", store: store(3) }]),
      registeredProjectIds: censusOf(REGISTERED),
    });

    await sampler.sampleDomain();
    const agents = familyOf(sampler.buildSnapshot(), "fusion_domain_project_running_agents");

    // Chosen deliberately: no fabricated zero series for the 24 cold projects. Absence stays absence.
    expect(agents.samples).toHaveLength(1);
    expect(agents.samples[0].labelValues).toEqual(["proj_0"]);
    // The rendered help line is the operator-facing contract for that absence.
    expect(agents.help).toContain("no series");
    expect(agents.help).toContain("not measured");
    // And the total's help line names its own source, so a reader can tell projects from warm stores.
    expect(familyOf(sampler.buildSnapshot(), "fusion_domain_projects_total").help).toContain(
      "registry",
    );
  });

  it("the registry census wins over store warmth even when the registry is SMALLER than the open set", async () => {
    // A store whose project is not registered is the registry-inconsistent case: the registry is the
    // stated source of truth for existence, and the agent series keeps the activity visible.
    const sampler = createDomainSampler({
      ...registryOf([
        { projectId: "proj_0", store: store(1) },
        { projectId: "proj_unregistered", store: store(1) },
      ]),
      registeredProjectIds: censusOf(["proj_0"]),
    });

    await sampler.sampleDomain();
    const families = sampler.buildSnapshot();

    expect(gauge(families, "fusion_domain_projects_total")).toBe(1);
    expect(gauge(families, "fusion_domain_projects_active")).toBe(1);
    expect(familyOf(families, "fusion_domain_project_running_agents").samples).toHaveLength(2);
  });
});

describe("census degradation is never a warming number", () => {
  it("no registry at all (embedded boot) degrades to the served-store count, never to 0", async () => {
    // The pre-RUFU-912 behaviour is the honest floor when there is no registry to ask.
    const sampler = createDomainSampler(registryOf([{ projectId: "proj_0", store: store(1) }]));

    await sampler.sampleDomain();
    expect(gauge(sampler.buildSnapshot(), "fusion_domain_projects_total")).toBe(1);
  });

  it("a census that fails AFTER a good one keeps the registry count instead of collapsing to stores", async () => {
    let fail = false;
    const sampler = createDomainSampler({
      ...registryOf([{ projectId: "proj_0", store: store(1) }]),
      registeredProjectIds: async () => {
        if (fail) throw new Error("central registry unreachable");
        return REGISTERED;
      },
    });

    await sampler.sampleDomain();
    fail = true;
    await sampler.sampleDomain();

    // One transient central failure must not put the 25 -> 1 lie back on the panel.
    expect(gauge(sampler.buildSnapshot(), "fusion_domain_projects_total")).toBe(REGISTERED.length);
  });

  it("a MEASURED empty registry is 0, which is not the same answer as an unreadable one", async () => {
    const sampler = createDomainSampler({
      ...registryOf([{ projectId: "proj_0", store: store(1) }]),
      registeredProjectIds: async () => [],
    });

    await sampler.sampleDomain();
    expect(gauge(sampler.buildSnapshot(), "fusion_domain_projects_total")).toBe(0);
  });

  it("a registry that never answers cannot wedge the tick: it degrades inside the bound", async () => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      const sampler = createDomainSampler({
        ...registryOf([{ projectId: "proj_0", store: store(1) }]),
        registeredProjectIds: () => {
          reads += 1;
          return new Promise<string[] | null>(() => undefined);
        },
      });

      const tick = sampler.sampleDomain();
      await vi.advanceTimersByTimeAsync(REGISTRY_CENSUS_BOUND_MS + 1);
      await tick;

      expect(gauge(sampler.buildSnapshot(), "fusion_domain_projects_total")).toBe(1);
      expect(reads).toBe(1);

      // A second tick must NOT start a second read: the in-flight slot is released only when the
      // underlying read settles, and this one never does, so `readRegistryCensus` short-circuits on the
      // already-resolved guarded promise. A per-tick pile-up would read 2 here.
      const tickTwo = sampler.sampleDomain();
      await vi.advanceTimersByTimeAsync(REGISTRY_CENSUS_BOUND_MS + 1);
      await tickTwo;
      expect(reads).toBe(1);

      // Same for a third tick: one dangling read for the process's lifetime, not one per 5 s.
      const tickThree = sampler.sampleDomain();
      await vi.advanceTimersByTimeAsync(REGISTRY_CENSUS_BOUND_MS + 1);
      await tickThree;
      expect(reads).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a reader that throws synchronously is just an unreadable registry, not a thrown tick", async () => {
    const sampler = createDomainSampler({
      ...registryOf([{ projectId: "proj_0", store: store(1) }]),
      registeredProjectIds: (() => {
        throw new Error("central core not initialized");
      }) as never,
    });

    await expect(sampler.sampleDomain()).resolves.toBeUndefined();
    expect(gauge(sampler.buildSnapshot(), "fusion_domain_projects_total")).toBe(1);
  });
});

describe("resolveProjectPopulation (the precedence the gauges count)", () => {
  it("prefers the census, then the retained census, then the served stores", () => {
    expect(resolveProjectPopulation(["a", "b"], ["z"], ["s"])).toEqual(["a", "b"]);
    expect(resolveProjectPopulation(null, ["z"], ["s"])).toEqual(["z"]);
    expect(resolveProjectPopulation(null, null, ["s"])).toEqual(["s"]);
    // An empty CENSUS is a measurement, so it must not fall through to the retained/served sets.
    expect(resolveProjectPopulation([], ["z"], ["s"])).toEqual([]);
  });

  it("drops malformed and duplicate ids so they can never inflate a count", () => {
    expect(
      resolveProjectPopulation(["a", "a", "", 42 as unknown as string, undefined as unknown as string], null, []),
    ).toEqual(["a"]);
  });
});

describe("createRegisteredProjectIdReader (the server's census wiring)", () => {
  it("maps registry rows to deduped ids, which is the whole fleet regardless of store warmth", async () => {
    const read = createRegisteredProjectIdReader({
      listProjects: async () => REGISTERED.map((id) => ({ id, name: id, status: "active" })),
    });
    await expect(read()).resolves.toEqual(REGISTERED);
  });

  it("resolves null for a missing central registry and for a rejected or thrown read", async () => {
    await expect(createRegisteredProjectIdReader({})()).resolves.toBeNull();
    await expect(
      createRegisteredProjectIdReader({
        listProjects: async () => {
          throw new Error("central core not initialized");
        },
      })(),
    ).resolves.toBeNull();
    await expect(
      createRegisteredProjectIdReader({
        listProjects: (() => {
          throw new Error("central core not initialized");
        }) as never,
      })(),
    ).resolves.toBeNull();
    // A lister that answers "no central view" is unreadable, not an empty fleet.
    await expect(createRegisteredProjectIdReader({ listProjects: async () => undefined })()).resolves.toBeNull();
  });

  it("keeps a genuinely empty registry as an empty census, and skips blank or duplicate ids", async () => {
    await expect(createRegisteredProjectIdReader({ listProjects: async () => [] })()).resolves.toEqual([]);
    await expect(
      createRegisteredProjectIdReader({
        listProjects: async () => [{ id: "proj_a" }, { id: "proj_a" }, { id: "  " }, {}, { id: 7 }],
      })(),
    ).resolves.toEqual(["proj_a"]);
  });
});
