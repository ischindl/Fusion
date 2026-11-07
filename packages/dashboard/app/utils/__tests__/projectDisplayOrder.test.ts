import { describe, expect, it } from "vitest";
import {
  compareProjectsByStateThenName,
  projectStateGroup,
  sortProjectsByStateThenName,
  type ProjectStateEntry,
} from "../projectDisplayOrder";

/*
FNXC:ProjectRuntimeOff 2026-11-07-17:41 (RUFU-871):
The combo must show EVERY registered project again, grouped LIVE → PAUSED → TURNED OFF and
alphabetical inside each group. This is the pure ordering the component calls; asserting it here
rather than through a render keeps the contract testable without React, and keeps a component
render free of the sorting side effect.
*/

function project(
  name: string,
  overrides: Partial<ProjectStateEntry> = {},
): ProjectStateEntry {
  return { name, status: "active", runtimeEnabled: true, ...overrides };
}

describe("projectStateGroup", () => {
  it("classifies a loaded, unpaused project as live", () => {
    expect(projectStateGroup(project("Alpha"))).toBe("live");
  });

  it("classifies a paused project row as paused while its runtime is loaded", () => {
    expect(projectStateGroup(project("Beta", { status: "paused" }))).toBe("paused");
  });

  it("classifies a runtime-off project as off even when its project row is active", () => {
    expect(projectStateGroup(project("Gamma", { runtimeEnabled: false }))).toBe("off");
  });

  it("treats an absent runtimeEnabled as enabled, matching the gate's own default", () => {
    expect(projectStateGroup({ name: "Delta", status: "active" })).toBe("live");
  });
});

describe("sortProjectsByStateThenName", () => {
  it("orders live, then paused, then turned-off, alphabetical inside each group", () => {
    const ordered = sortProjectsByStateThenName([
      project("zeta-off", { runtimeEnabled: false }),
      project("mike-paused", { status: "paused" }),
      project("alpha-live"),
      project("bravo-off", { runtimeEnabled: false, status: "paused" }),
      project("charlie-paused", { status: "paused" }),
      project("delta-live"),
    ]);

    expect(ordered.map((p) => p.name)).toEqual([
      "alpha-live",
      "delta-live",
      "charlie-paused",
      "mike-paused",
      "bravo-off",
      "zeta-off",
    ]);
  });

  it("sorts names case-insensitively inside a group", () => {
    const ordered = sortProjectsByStateThenName([
      project("beta"),
      project("Alpha"),
      project("charlie"),
    ]);
    expect(ordered.map((p) => p.name)).toEqual(["Alpha", "beta", "charlie"]);
  });

  it("does not mutate the caller's array", () => {
    const input = [project("zeta"), project("alpha")];
    const snapshot = input.map((p) => p.name);
    sortProjectsByStateThenName(input);
    expect(input.map((p) => p.name)).toEqual(snapshot);
  });

  it("is a stable total order usable directly by Array.sort", () => {
    const a = project("a", { runtimeEnabled: false });
    const b = project("b");
    expect(compareProjectsByStateThenName(a, b)).toBeGreaterThan(0);
    expect(compareProjectsByStateThenName(b, a)).toBeLessThan(0);
    expect(compareProjectsByStateThenName(a, project("a", { runtimeEnabled: false }))).toBe(0);
  });
});
