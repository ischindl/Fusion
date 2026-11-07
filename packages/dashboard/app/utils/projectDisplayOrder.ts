/**
 * FNXC:ProjectRuntimeOff 2026-11-07-17:41 (RUFU-871):
 * ONE ordering for every project list the operator reads, so "which projects are actually running"
 * is answered by position rather than by hunting. Production measurement behind this: 25 registered
 * projects, 5 of them with `runtimeEnabled: false`. The project combo had no runtime field in
 * `GET /api/projects`, so a turned-off project was indistinguishable from a loaded one and was
 * simply missing from the operator's mental model of the board.
 *
 * Three state groups, in this order:
 * - `live`     — the engine runtime is loaded and the project is not paused.
 * - `paused`   — the runtime is loaded but the project is paused (operator paused the project row).
 * - `off`      — the operator unloaded the runtime (`runtimeEnabled: false`). Last, because the
 *                operator parked these on purpose and does not want them competing for attention.
 *
 * `status` is NOT repurposed: production `status` reads `active` (11) / `paused` (14) and means the
 * project-row lifecycle, a different axis from the runtime switch. The group is therefore derived
 * from BOTH fields and never from `status` alone.
 *
 * Pure module on purpose: no store, no clock, no React. A component calls it, a unit test owns it.
 */

/** The three operator-visible state groups, in display order. */
export type ProjectStateGroup = "live" | "paused" | "off";

/** The minimum a list host must expose for the ordering to decide. */
export interface ProjectStateEntry {
  name: string;
  status?: string;
  /** Absent means enabled: `isProjectRuntimeEnabled`'s own rule, so an older server stays live. */
  runtimeEnabled?: boolean;
}

/** Display order of the groups; lower sorts first. */
export const PROJECT_STATE_GROUP_ORDER: readonly ProjectStateGroup[] = ["live", "paused", "off"];

/**
 * Classify one project into its display group. A runtime-off project is `off` whatever its
 * `status` says, because the runtime switch is the fact the operator is asking about; among
 * loaded projects, only a paused project row drops out of `live`.
 */
export function projectStateGroup(project: ProjectStateEntry): ProjectStateGroup {
  if (project.runtimeEnabled === false) return "off";
  if (project.status === "paused") return "paused";
  return "live";
}

/** Ascending comparator: state group first, then project name inside the group. */
export function compareProjectsByStateThenName(
  a: ProjectStateEntry,
  b: ProjectStateEntry,
): number {
  const groupDelta =
    PROJECT_STATE_GROUP_ORDER.indexOf(projectStateGroup(a))
    - PROJECT_STATE_GROUP_ORDER.indexOf(projectStateGroup(b));
  if (groupDelta !== 0) return groupDelta;
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

/**
 * Sort a project list for display without mutating the caller's array (a React memo input must
 * not be reordered in place). Stable for equal keys, which `Array.prototype.sort` guarantees.
 */
export function sortProjectsByStateThenName<T extends ProjectStateEntry>(
  projects: readonly T[],
): T[] {
  return [...projects].sort(compareProjectsByStateThenName);
}
