import { describe, expect, it, vi } from "vitest";
import { InProcessRuntime } from "../runtimes/in-process-runtime.js";
import { ChildProcessRuntime } from "../runtimes/child-process-runtime.js";
import { RemoteNodeRuntime } from "../runtimes/remote-node-runtime.js";
import {
  INFLIGHT_OBSERVATION_READ_TIMEOUT_MS,
  INFLIGHT_PROBE_TIMEOUT_MS,
} from "../project/project-runtime.js";
import type {
  InFlightObservation,
  InFlightObservationSource,
  ProjectRuntime,
  ProjectRuntimeConfig,
} from "../project/project-runtime.js";

const mockGetMetrics = vi.hoisted(() => vi.fn());

// The remote arm must never touch a socket: the whole point of its contract is what it says when the
// node cannot be reached, so the client is replaced rather than stubbed at the transport layer.
vi.mock("../runtimes/remote-node-client.js", () => ({
  RemoteNodeClient: vi.fn().mockImplementation(function () {
    return {
      health: vi.fn().mockResolvedValue({ status: "ok", version: "0.0.0", uptime: 1 }),
      getMetrics: mockGetMetrics,
      streamEvents: vi.fn(() => ({ cancel: vi.fn() })),
      pollPendingAssignments: vi.fn().mockResolvedValue([]),
    };
  }),
}));

/*
FNXC:RuntimeInFlightProvenance 2026-10-18-11:21 (RUFU-332):
What the per-transport suites cannot pin from inside one file: that `observeInFlight()` means the SAME
thing on all three transports, and that a transport with nothing to ask never certifies idleness.

The incident this exists for ran on the child-process transport, where `getMetrics()` answered from a
cache: a card parked `failed` while still holding an in-memory checkout kept the cached count above zero
and refused an isolation transition there; the same cache shape inverted — never filled — read as zero and
would have permitted a transition over live work. Both halves are the same defect: a cached transport
estimate was consulted as if it were a decision-time observation. `getMetrics()` stays a display/health
estimate (permitted to be cached); `observeInFlight()` is the only form a lifecycle guard may decide from,
and `proven: false` may never be read as idle.
*/

const OBSERVATION_SOURCES: InFlightObservationSource[] = [
  "in-process",
  "child-process",
  "remote-node",
  "unavailable",
];

const config = {
  projectId: "proj_probe_contract",
  workingDirectory: "/tmp/probe-contract",
  isolationMode: "in-process",
} as ProjectRuntimeConfig;

function inProcess(): ProjectRuntime {
  return new InProcessRuntime(config, {} as never);
}

function child(): ProjectRuntime {
  return new ChildProcessRuntime(config, {} as never);
}

function remote(): ProjectRuntime {
  return new RemoteNodeRuntime({
    projectId: config.projectId,
    workingDirectory: config.workingDirectory,
    isolationMode: "in-process",
    nodeConfig: {
      id: "node_probe",
      name: "Probe Node",
      type: "remote",
      url: "https://probe.example.com",
      apiKey: "token",
      status: "online",
      maxConcurrent: 2,
      createdAt: "2026-04-08T00:00:00.000Z",
      updatedAt: "2026-04-08T00:00:00.000Z",
    },
  } as never);
}

function assertWellFormed(observation: InFlightObservation): void {
  expect(Number.isFinite(observation.inFlightTasks)).toBe(true);
  expect(observation.inFlightTasks).toBeGreaterThanOrEqual(0);
  expect(typeof observation.proven).toBe("boolean");
  expect(OBSERVATION_SOURCES).toContain(observation.source);
}

describe("ProjectRuntime in-flight observation contract", () => {
  it("declares the decision-time seam on every production transport", () => {
    /*
    The seam is optional on the interface — a transport that reads its own state synchronously has no
    round trip to be stale about — but every transport that DOES have a peer must answer in this form.
    A fourth transport added later without it would silently fall back to the cached estimate, which is
    the exact shape of the reported bug, so the omission has to fail here rather than in production.
    */
    for (const transport of [InProcessRuntime, ChildProcessRuntime, RemoteNodeRuntime]) {
      expect(typeof (transport as { prototype: Record<string, unknown> }).prototype.observeInFlight).toBe(
        "function",
      );
    }
  });

  it.each([
    { name: "in-process", make: inProcess },
    { name: "child-process", make: child },
    { name: "remote-node", make: remote },
  ])("answers as a well-formed observation on $name without throwing", async ({ make }) => {
    mockGetMetrics.mockRejectedValue(new Error("node unreachable"));
    const runtime = make();

    const observation = await runtime.observeInFlight!();

    assertWellFormed(observation);
  });

  it.each([
    { name: "child-process", make: child, source: "child-process" },
    { name: "remote-node", make: remote, source: "remote-node" },
  ])(
    "refuses to certify idleness on $name while it has nothing to ask",
    async ({ make, source }) => {
      // Nothing has been started or reached: the only honest answer is "cannot prove it", carrying the
      // last number it saw — never a zero, which would read as permission to restart.
      mockGetMetrics.mockRejectedValue(new Error("node unreachable"));
      const runtime = make();

      const observation = await runtime.observeInFlight!();

      expect(observation).toMatchObject({ proven: false, source });
    },
  );

  it("certifies idleness on in-process, which reads its own executor with no peer in between", async () => {
    // The asymmetry is deliberate and load-bearing: treating a synchronous transport as unprovable would
    // refuse every transition on the default isolation mode.
    const observation = await inProcess().observeInFlight!();

    expect(observation).toEqual({ inFlightTasks: 0, proven: true, source: "in-process" });
  });

  it("keeps the transport probe bound strictly inside the guard's observation bound", () => {
    /*
    Ordering contract, not tuning: the guard's own bound must be the looser one, so a transport that
    honours its own budget always gets to report its OWN uncertainty (`proven: false`, with a source that
    names which peer failed) before the guard substitutes its blunter fallback. Invert these two constants
    and every busy-looking child or remote node is reported as `unavailable` instead of by name, which is
    the diagnostic half of why the refusal happened.
    */
    expect(INFLIGHT_PROBE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(INFLIGHT_OBSERVATION_READ_TIMEOUT_MS).toBeGreaterThan(INFLIGHT_PROBE_TIMEOUT_MS);
  });
});
