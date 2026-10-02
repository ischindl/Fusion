/*
FNXC:CliPackaging 2026-10-02-14:05 (RUFU-500):
Sibling worker entries are the only reason `fork()` can find a worker in a published install: both workers are
resolved as a file next to the running compiled module, and the published package once omitted
`child-process-worker.js` so child-process isolation failed with ERR_MODULE_NOT_FOUND. The knowledge-graph
worker degrades worse than that — a missing sibling makes the offloader fall back to an in-process build,
which is the 84.8%-of-the-dashboard-CPU condition this offload exists to remove, and it fails no test. So the
entry names are asserted here.
*/
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const config = readFileSync(fileURLToPath(new URL("../../tsup.config.ts", import.meta.url)), "utf8");

describe("CLI worker sibling entries", () => {
  // Every worker resolved as a sibling of dist/bin.js must be emitted under that exact output name.
  const REQUIRED_WORKER_ENTRIES: Array<[outputName: string, sourceSuffix: string]> = [
    ["child-process-worker", "runtimes/child-process-worker.ts"],
    ["knowledge-graph-worker", "knowledge-graph/build-worker.ts"],
  ];

  for (const [outputName, sourceSuffix] of REQUIRED_WORKER_ENTRIES) {
    it(`emits ${outputName} from ${sourceSuffix}`, () => {
      const pattern = new RegExp(`"${outputName}"\\s*:\\s*"[^"]*${sourceSuffix.replace("/", "\\/")}"`);
      expect(config).toMatch(pattern);
    });
  }
});
