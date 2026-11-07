/*
FNXC:TaskListReadProjectScope 2026-11-07-03:55 (RUFU-871 slice 2):
`createTaskStoreForBackend({ rootDir })` without a `projectId` lets the startup factory
re-derive the partition from the path (a registry lookup with a `local-<hash>` fallback). On
the shared PostgreSQL `project.tasks` table that is a different partition from the one a
registered project's own rows live under, and slice 2 now refuses an unbound task LIST read
outright — so a CLI store that should be bound has to say so at the boot.

`createProjectStore` is the CLI's shared boot. Exactly one of its callers may stay unbound:
the pre-registration `.fusion/` bootstrap inside `registerProjectInteractive`, which runs
before `central.ensureProjectForPath` creates the registry row and therefore has no id to
pass (and performs no task list read, only a settings write). This scan keeps that exception
a single, located fact rather than a habit.
*/
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SOURCE_REL = "../project-resolver.ts";
const source = () =>
  readFileSync(resolve(import.meta.dirname, SOURCE_REL), "utf8")
    // Scan code, not prose: comments may name the helper without calling it.
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

/** Every `createProjectStore(...)` CALL site (the definition is excluded), with its arguments. */
function callSites() {
  const text = source();
  const sites: Array<{ args: string; index: number }> = [];
  for (const match of text.matchAll(/(?<!function )createProjectStore\(([^)]*)\)/g)) {
    sites.push({ args: match[1] ?? "", index: match.index ?? 0 });
  }
  return sites;
}

describe("project-resolver binds its project stores to a registry id", () => {
  it("the shared boot can carry a projectId", () => {
    expect(source()).toMatch(
      /async function createProjectStore\(rootDir: string, projectId\?: string\)/,
    );
  });

  it("every resolvable caller names the project id it already holds", () => {
    const bound = callSites().filter((site) => site.args.includes(","));
    expect(bound.length).toBeGreaterThanOrEqual(2);
    for (const site of bound) {
      expect(site.args).toContain("project.id");
    }
  });

  it("only the pre-registration bootstrap boots unbound, and it precedes the registry row", () => {
    const text = source();
    const unbound = callSites().filter((site) => !site.args.includes(","));
    expect(unbound.map((site) => site.args)).toEqual(["absPath"]);

    const initFn = text.indexOf("export async function registerProjectInteractive");
    expect(initFn, "the init helper is the expected home of the one unbound boot").toBeGreaterThan(0);
    const nextFunction = text.slice(initFn + 1).search(/^(?:export\s+)?(?:async\s+)?function\s+\w+/m);
    const initFnEnd = nextFunction === -1 ? text.length : initFn + 1 + nextFunction;
    const registration = text.indexOf("central.ensureProjectForPath(", initFn);
    expect(
      registration,
      "the registration call is where a project id starts to exist",
    ).toBeGreaterThan(initFn);
    expect(registration).toBeLessThan(initFnEnd);
    for (const site of unbound) {
      expect(site.index, "the unbound boot must be the init helper's own pre-registration path").toBeGreaterThan(initFn);
      expect(
        site.index,
        "a store booted after registration has an id available and must pass it",
      ).toBeLessThan(registration);
    }
  });
});
