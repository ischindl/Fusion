import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/*
FNXC:GhProbeShared 2026-11-09-15:28 (RUFU-909):
RUFU-871 established ONE owner for "is `gh` installed / logged in" and shipped async twins that
single-flight concurrent probes, then converted only the usage route. `GET /api/settings` and
`GET /api/auth/status` kept calling the sync pair, whose `execFileSync("gh", ["auth","status"])`
is a network round trip (655 ms measured on this host) that parks the dashboard's event loop for
every in-flight request in the process. Nothing failed when the second and third read surfaces
were left behind, so the conversion is now a call-site allowlist: a polled read surface may not
check out the blocking probe.

This is a call-site inventory, not a comment assertion — the same shape as
`engine-no-blocking-shellout.test.ts`. The allowlist names the remaining sync consumers and why
each is not a polled read, so a new read surface defaults to forbidden.
*/

const ROUTES_DIR = resolve(__dirname, "..");

/**
 * Remaining sync `isGhAvailable()` / `isGhAuthenticated()` consumers under `routes/`, with the
 * reason each is out of scope for this ratchet. Converting one means deleting its entry.
 */
const SYNC_PROBE_ALLOWLIST: Record<string, string> = {
  // POST-only action routes: `gh` must be present for the action being requested, the route is
  // user-triggered (not polled), and it shells out to `gh` many times anyway.
  "register-git-github.ts": "action routes, already spawn `gh` repeatedly per request",
  "register-task-workflow-routes.ts": "passed as a lazy capability predicate to a command lane",
};

function routeSource(fileName: string): string {
  return readFileSync(resolve(ROUTES_DIR, fileName), "utf8");
}

/*
Strip comments before scanning. The FNXC note on each converted site QUOTES the call it removed, so
a raw text scan matches the prose and reports a violation that does not exist. Same reason
`legacy-tombstones.test.ts` strips comments first: prose is not a call site.
*/
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\\/])\/\/[^\n]*/g, "$1");
}

const SYNC_CALL = /\bisGh(?:Available|Authenticated)\s*\(\s*\)/g;

function syncProbeCalls(fileName: string): string[] {
  return stripComments(routeSource(fileName)).match(SYNC_CALL) ?? [];
}

describe("gh auth probe has one owner per read surface (RUFU-909)", () => {
  it("names every route file that still uses the blocking sync probe", () => {
    const offenders = Object.keys(SYNC_PROBE_ALLOWLIST)
      .filter((name) => syncProbeCalls(name).length === 0);
    SYNC_CALL.lastIndex = 0;
    expect(
      offenders,
      `stale allowlist entry — that file no longer calls the sync probe, delete it: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it.each(["register-settings-memory-routes.ts", "register-auth-routes.ts"])(
    "%s never checks out the blocking sync probe",
    (fileName) => {
      expect(syncProbeCalls(fileName)).toEqual([]);
      expect(routeSource(fileName)).toContain("isGhAvailableAsync");
      expect(routeSource(fileName)).toContain("isGhAuthenticatedAsync");
    },
  );

  it("keeps every other route file off the sync probe", () => {
    // One level deep on purpose: routes/ holds its own registrars flat.
    const files = readdirSync(ROUTES_DIR)
      .filter((name) => name.endsWith(".ts") && !SYNC_PROBE_ALLOWLIST[name]);
    expect(files.length).toBeGreaterThan(10);
    for (const name of files) {
      expect(
        syncProbeCalls(name),
        `${name} must await the shared async gh probe, not execFileSync it`,
      ).toEqual([]);
    }
  });
});
