// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { readProjectRuntimeEnabledFlags } from "../async/async-settings.js";

/*
FNXC:ProjectRuntimeOff 2026-11-07-20:30 (RUFU-871):
`GET /api/projects` has to answer the operator's runtime-unload flag for EVERY registered project.
Doing it per project meant opening a TaskStore per row inside a read route, and a store that would not
open was being read as an answer: 14 of 25 projects reported "unknown" while `project.config.settings`
held the true value for all of them. This helper is the one batched read that replaced that path.

The semantics pinned here are the whole contract, and the two defaults are NOT the same thing:
- a row whose settings carry `runtimeEnabled = false` is the ONLY thing that yields false;
- a row whose settings do not carry the key yields true — the gate's own default, because "no key
  written" really is "never turned off" (`isProjectRuntimeEnabled`);
- a project with NO row is absent from the result rather than defaulted. "No row" is the absence of an
  answer, not an answer, and the caller renders it `unknown` instead of guessing either way.
*/

/** Drizzle handle stand-in: the projection needs the query SHAPE, not a database. */
function fakeHandle(rows: Array<{ projectId: string; runtimeEnabled: string | null }>) {
  const from = vi.fn(async () => rows);
  const select = vi.fn(() => ({ from }));
  return { handle: { select } as never, select, from };
}

describe("readProjectRuntimeEnabledFlags", () => {
  it("reads every project in one query, not one per project", async () => {
    const { handle, select } = fakeHandle([
      { projectId: "p-0", runtimeEnabled: null },
      { projectId: "p-1", runtimeEnabled: "false" },
    ]);

    await readProjectRuntimeEnabledFlags(handle);

    expect(select).toHaveBeenCalledTimes(1);
  });

  it("maps the persisted flag: false is false, true is true, an absent key is enabled", async () => {
    const { handle } = fakeHandle([
      { projectId: "p-off", runtimeEnabled: "false" },
      { projectId: "p-on", runtimeEnabled: "true" },
      // `settings ->> 'runtimeEnabled'` is NULL for both an absent key and a NULL settings column.
      { projectId: "p-never-set", runtimeEnabled: null },
    ]);

    const flags = await readProjectRuntimeEnabledFlags(handle);

    expect(flags).toEqual({ "p-off": false, "p-on": true, "p-never-set": true });
  });

  it("leaves a project with no settings row out of the result instead of defaulting it", async () => {
    /*
    Defaulting an unread project to enabled is the bug that shipped first, and defaulting it to enabled
    HERE would let the caller never distinguish it. Absence is the signal the projection turns into
    `runtimeState: "unknown"`.
    */
    const { handle } = fakeHandle([{ projectId: "p-known", runtimeEnabled: "false" }]);

    const flags = await readProjectRuntimeEnabledFlags(handle);

    expect("p-missing" in flags).toBe(false);
    expect(Object.keys(flags)).toEqual(["p-known"]);
  });

  it("ignores the SQLite-parity row that names no registered project", async () => {
    // `project.config.project_id` keeps a '' default for single-project/SQLite-parity writes.
    const { handle } = fakeHandle([
      { projectId: "", runtimeEnabled: "false" },
      { projectId: "p-real", runtimeEnabled: "false" },
    ]);

    const flags = await readProjectRuntimeEnabledFlags(handle);

    expect(flags).toEqual({ "p-real": false });
  });
});
