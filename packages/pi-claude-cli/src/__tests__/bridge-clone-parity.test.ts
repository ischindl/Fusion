import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * RUFU-520. The two CLI bridges are intentional clones, and a clone that drifts is how a fix
 * reaches one lane and the other keeps the bug. Both lanes carry the tool-surface invariant, so
 * this test pins the family as a clean rename-diff, the same ratchet the runtime skill loaders use.
 *
 * Normalized renames are the only legal difference. Anything else shows up as the first differing
 * line, naming both files.
 */

const ROOT = resolve(__dirname, "..", "..", "..", "..");

/** Rewrite the Droid clone into the Claude spelling so the two files can be compared literally. */
function toClaudeSpelling(source: string): string {
  return source
    .replace(/mapDroidToolNameToPi/g, "mapClaudeToolNameToPi")
    .replace(/isPiKnownDroidTool/g, "isPiKnownClaudeTool")
    .replace(/\[droid-cli\]/g, "[pi-claude-cli]")
    .replace(/the Droid CLI/g, "the Claude CLI")
    .replace(/The Droid CLI/g, "The Claude CLI")
    .replace(/Droid receives/g, "Claude receives")
    .replace(/droid-pro/g, "claude-sonnet-4-5")
    .replace(/internal CLI Code tools/g, "internal Claude Code tools");
}

/*
 FNXC:ToolDispatchIntegrity 2026-11-11-05:12:
 Pre-existing per-package convention, not drift: the plugin builds under nodenext and spells some
 relative imports with an explicit `.js`, the pi lane mixes both. The strip is applied to BOTH sides,
 so the comparison ignores the spelling without excusing a difference in which module is named.
 Each package's own typecheck is what proves its specifiers resolve.
*/
function normalizeModuleSpecifiers(source: string): string {
  return source.replace(/(from "\.\.[\/\w-]+)\.js";/g, '$1";');
}

function read(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), "utf-8");
}

/*
 FNXC:ToolDispatchIntegrity 2026-11-11-04:02:
 The absence checks below name the code they forbid, in comments, to explain the deletion. Those
 comments are expected to remain; only the code must stay gone. Stripping comments first is the same
 discipline `legacy-tombstones.test.ts` uses, and it is what keeps this ratchet from failing on its
 own documentation.
*/
/** Remove block and line comments so an absence check cannot be tripped by prose about the deleted code. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** Report the first difference with enough context to act on it. */
function firstDifference(left: string, right: string): string | undefined {
  const leftLines = left.split("\n");
  const rightLines = right.split("\n");
  const shared = Math.max(leftLines.length, rightLines.length);
  for (let index = 0; index < shared; index += 1) {
    if (leftLines[index] !== rightLines[index]) {
      return (
        `line ${index + 1}:\n` +
        `  claude: ${leftLines[index] ?? "<file ends>"}\n` +
        `  droid:  ${rightLines[index] ?? "<file ends>"}`
      );
    }
  }
  return undefined;
}

const CLONE_PAIRS: Array<{ label: string; claude: string; droid: string }> = [
  {
    label: "tool-surface module",
    claude: "pi-claude-cli/src/tool-surface.ts",
    droid: "fusion-plugin-droid-runtime/src/tool-surface.ts",
  },
  {
    label: "schema-only MCP server",
    claude: "pi-claude-cli/src/mcp-schema-server.cjs",
    droid: "fusion-plugin-droid-runtime/src/mcp-schema-server.cjs",
  },
  {
    label: "tool-surface unit tests",
    claude: "pi-claude-cli/src/__tests__/tool-surface.test.ts",
    droid: "fusion-plugin-droid-runtime/src/__tests__/tool-surface.test.ts",
  },
  {
    label: "tool-request guard tests",
    claude: "pi-claude-cli/src/__tests__/event-bridge-tool-surface-guard.test.ts",
    droid: "fusion-plugin-droid-runtime/src/__tests__/event-bridge-tool-surface-guard.test.ts",
  },
  {
    label: "schema-server tools/call tests",
    claude: "pi-claude-cli/src/__tests__/mcp-schema-server-tool-call.test.ts",
    droid: "fusion-plugin-droid-runtime/src/__tests__/mcp-schema-server-tool-call.test.ts",
  },
];

/*
 FNXC:ToolDispatchIntegrity 2026-11-11-04:02:
 Deliberately NOT compared as whole files: `event-bridge.ts` and `provider.ts` already differed
 between the lanes before this card (import specifier style, the spawn-arg helpers, the pi lane's
 extra ACP route and cwd contract). The parity that RUFU-520 requires is that both lanes carry the
 same invariant, so the new modules are held to an exact rename-diff and the pre-existing files are
 held to the contract checks below.
*/

describe("RUFU-520 bridge clone parity", () => {
  for (const pair of CLONE_PAIRS) {
    it(`keeps the ${pair.label} clones in lockstep`, () => {
      const claude = normalizeModuleSpecifiers(read(`packages/${pair.claude}`));
      const droid = normalizeModuleSpecifiers(toClaudeSpelling(read(`plugins/${pair.droid}`)));
      const difference = firstDifference(claude, droid);
      expect(difference, `${pair.label} drifted:\n${difference ?? ""}`).toBeUndefined();
    });
  }

  it("keeps the droid-cli package copy of the schema server identical", () => {
    // The droid-cli package ships its own copy of the standalone server; three copies, one content.
    expect(read("packages/droid-cli/src/mcp-schema-server.cjs")).toBe(
      read("packages/pi-claude-cli/src/mcp-schema-server.cjs"),
    );
  });

  it("refuses a prior-state cached-config return in either bridge entry", () => {
    // The defect this card closes, asserted as an absence: no derivation-failure branch may answer
    // with a previously written config path, in either clone.
    for (const entry of ["packages/pi-claude-cli/index.ts", "packages/droid-cli/index.ts"]) {
      const source = stripComments(read(entry));
      expect(source, `${entry} returned a cached config path from a failure branch`).not.toMatch(
        /return cachedMcpConfig\?\.configPath/,
      );
    }
  });

  it("routes both bridge entries through the shared surface derivation", () => {
    for (const entry of ["packages/pi-claude-cli/index.ts", "packages/droid-cli/index.ts"]) {
      const source = stripComments(read(entry));
      expect(source, `${entry} derives its surface without reconcileToolSurface`).toContain(
        "reconcileToolSurface(",
      );
      expect(source, `${entry} declares a surface the prompt does not see`).toContain(
        "tools: surface.declaredTools",
      );
      expect(source, `${entry} still falls back to the registry-wide custom defs`).not.toContain(
        "getCustomToolDefs(",
      );
    }
  });

  it("passes the declared surface from every production bridge call site", () => {
    /*
     FNXC:ToolDispatchIntegrity 2026-11-11-05:12:
     RUFU-520. A bridge built without a surface keeps its historic passthrough, which is correct for
     a unit harness and wrong for a transport. The ACP driver was exactly that miss: a warm-session
     route that dispatched a request nobody had declared. So the rule is written over call sites
     rather than over the two provider files, and a future transport that forgets the surface fails
     here instead of shipping an unguarded lane.
    */
    const productionSources = [
      "packages/pi-claude-cli/src/provider.ts",
      "packages/pi-claude-cli/src/acp-driver.ts",
      "plugins/fusion-plugin-droid-runtime/src/provider.ts",
    ];
    for (const file of productionSources) {
      const body = stripComments(read(file));
      const callSites = [
        ...body.matchAll(/(?<!function )createEventBridge\(([\s\S]*?)\)\s*;/g),
      ];
      expect(callSites.length, `${file} builds no bridge`).toBeGreaterThan(0);
      for (const [, args] of callSites) {
        expect(
          args,
          `${file} builds a bridge that cannot refuse an unavailable tool`,
        ).toContain("declaredToolNames");
      }
    }
  });

  it("wires the guard into both bridge event loops", () => {
    for (const bridge of [
      "packages/pi-claude-cli/src/event-bridge.ts",
      "plugins/fusion-plugin-droid-runtime/src/event-bridge.ts",
    ]) {
      const source = stripComments(read(bridge));
      expect(source, `${bridge} never consults the disposition`).toContain("resolveToolRequestDisposition(");
      expect(source, `${bridge} has no unavailable-tool refusal`).toContain("toolNotAvailableMessage(");
      // The disposition is the only gate now; the old shape check must not come back.
      expect(source, `${bridge} still gates on the name shape alone`).not.toMatch(
        /if \(!isPiKnown(Droid|Claude)Tool\(claudeName\)\) \{/,
      );
    }
  });

  it("passes the declared surface from both providers into the bridge", () => {
    for (const provider of [
      "packages/pi-claude-cli/src/provider.ts",
      "plugins/fusion-plugin-droid-runtime/src/provider.ts",
    ]) {
      const source = read(provider);
      expect(source, `${provider} builds a bridge with no surface`).toContain("declaredToolNames:");
    }
  });
});
