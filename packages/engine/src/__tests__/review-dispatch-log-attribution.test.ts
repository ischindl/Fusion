/*
FNXC:ReviewDispatch 2026-10-02-16:40 (RUFU-478 diagnosis):
`ReviewDispatchSweep` runs once per project runtime, and a production log held 68 identical
`E4: no enabled reviewer agent exists` lines with no project on them. That made the review lane look dead
host-wide, when the measured truth is that 12 of 24 projects simply have no enabled reviewer agent — a real
configuration gap for those, and irrelevant noise for the rest. Attribution and a cooldown are what turn the
line into evidence, so both are pinned here rather than trusted to a comment.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewDispatchSweep } from "../scheduling/review-dispatch-sweep.js";

function makeSweep(options: { projectId?: string; now: () => number }) {
  const store = { getProjectId: () => options.projectId ?? null } as never;
  const agentStore = { listAgents: async () => [] as never[] } as never;
  const heartbeatMonitor = {} as never;
  return new ReviewDispatchSweep({
    store,
    agentStore,
    heartbeatMonitor,
    now: options.now,
    e4LogCooldownMs: 300_000,
  });
}

/** Reach the reviewer-resolution path directly; the card-facing candidate scan is not what is under test. */
async function resolveReviewer(sweep: ReviewDispatchSweep): Promise<unknown> {
  return await (sweep as unknown as { resolveReviewer: () => Promise<unknown> }).resolveReviewer();
}

describe("ReviewDispatchSweep log attribution", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let clock = 1_000_000;

  beforeEach(() => {
    clock = 1_000_000;
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const lines = () => warn.mock.calls.map((call) => String(call[0]));

  it("names the project on the reviewer-configuration warning", async () => {
    const sweep = makeSweep({ projectId: "proj_attribute_check", now: () => clock });
    await expect(resolveReviewer(sweep)).resolves.toBeNull();

    const written = lines();
    expect(written).toHaveLength(1);
    // The claim under test is attribution: a reader must be able to tell WHICH project lacks a reviewer.
    expect(written[0]).toContain("proj_attribute_check");
    expect(written[0]).toContain("E4");
  });

  it("repeats the steady-state gap only after the cooldown, and counts what it folded", async () => {
    const sweep = makeSweep({ projectId: "proj_cooldown_check", now: () => clock });
    await resolveReviewer(sweep);
    // Twenty ticks at a ten-second stride is 200 s — inside the 300 s window. (At 15 s the twentieth tick
    // lands exactly on the cooldown boundary and is legitimately allowed to write, which is not what this
    // assertion is about.)
    for (let tick = 0; tick < 20; tick++) {
      clock += 10_000;
      await resolveReviewer(sweep);
    }
    expect(lines()).toHaveLength(1);

    clock += 300_001;
    await resolveReviewer(sweep);
    const after = lines();
    expect(after).toHaveLength(2);
    // The folded count is what makes the silence honest rather than lost.
    expect(after[1]).toContain("20 repeats suppressed");
  });

  it("still warns when the store cannot name a project, rather than going quiet", async () => {
    const sweep = makeSweep({ now: () => clock });
    await resolveReviewer(sweep);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toContain("no enabled reviewer agent exists");
  });
});
