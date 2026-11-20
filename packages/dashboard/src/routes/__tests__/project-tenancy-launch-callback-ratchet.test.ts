// @vitest-environment node

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
FNXC:ProjectTenancy 2026-11-19-21:40 (RUFU-518):
Ratchet for the class the operator named after Code Review: "any `deps?.on*?.(task.id)`-style
engine-less callback dispatch - all 9 such callbacks - must be checked for the same
project-vs-launch-engine confusion."

The defect was never one route: `POST /tasks/:id/merge` answered `500 Task <id> not found` in ~0.05 s for
a card the same request could READ, because its merge implementation fell through to the LAUNCH project's
`options.onMerge` - whose store is a different project - whenever the named project's engine was cold.
Three sibling shapes of the same mistake were found and fixed on this card (the automation/routine
resolvers, where the fall-through EXECUTED a routine in the wrong project, and the three remote-login-URL
sites, which addressed a foreign project's token at the launch project's public tunnel).

A behaviour test cannot stop the NEXT one, because a new site has no test yet. This scan can: a project-
scoped route may not reach a launch-project object through a fallback operator or a bare `options.on*`
reference. Every pre-existing site that legitimately does is allowlisted below WITH A REASON, an entry
that stops matching is stale and fails, and the named guards that replaced the fixed shapes are pinned so
deleting one goes red here as well as in the behaviour file.

The scan runs on COMMENT-STRIPPED source. That is load-bearing, not tidiness: the fixed merge route and
this card's own explanatory comments both quote `options?.onMerge` in prose, so an unstripped scan reports
the fix's own documentation as a violation of it.
*/

const ROUTES_DIR = fileURLToPath(new URL("..", import.meta.url));
const CONTEXT_FILE = "context.ts";

/** Strip block and line comments WITHOUT changing the line count, so a reported line number stays true. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/** Collapse runs of whitespace so an allowlist literal survives re-indentation and line wrapping. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Forbidden shapes, MOST SPECIFIC FIRST: a line is classified by the first pattern that matches it, so
 * the report says which class grew rather than double-counting a line under three ids.
 */
const FORBIDDEN_SHAPES = [
  { id: "launch-callback-dispatch", pattern: /\b(?:options|deps)\??\.on[A-Z]\w*/ },
  // Zero hits today: this card eliminated it (the three remote-login-URL sites). Kept so it cannot return.
  { id: "launch-engine-fallthrough", pattern: /\?\?\s*options\??\.engine\b/ },
  // Taking the FIRST engine of the process as if it were the caller's project's engine.
  { id: "first-engine-as-project-data", pattern: /getAllEngines\(\)\s*\.\s*values\(\)\s*\.\s*next\(\)/ },
  // A deliberate fan-out over every project is not a substitution; it is still worth a reasoned entry.
  { id: "every-engine-broadcast", pattern: /getAllEngines\(\)\s*\.\s*values\(\)/ },
  // Any `?? options?.x` / `?? ctx.options?.x` fallback: a per-request resolution landing on a launch object.
  { id: "launch-option-fallthrough", pattern: /\?\?\s*(?:options|deps|ctx\.options)\??\.[A-Za-z]/ },
] as const;

interface ForbiddenHit {
  file: string;
  line: number;
  shape: string;
  text: string;
}

/** One sanctioned site. `literal` is matched against the NORMALIZED line so re-wrapping cannot hide a site. */
interface AllowlistEntry {
  file: string;
  literal: string;
  shape: string;
  reason: string;
}

/*
FNXC:ProjectTenancy 2026-11-19-21:40 (RUFU-518):
The complete inventory of sanctioned sites, measured by running the collector over `register-*.ts` - not
assembled from guesses. Two are genuine residuals and say so; the rest are process-global capabilities or
launch-tenancy legs that the guard above already keeps unreachable for a foreign project.
*/
const ALLOWLIST: AllowlistEntry[] = [
  {
    file: "register-task-workflow-routes.ts",
    // The whole ternary else-branch is pinned, not the substring `options?.onMerge`: reverting the guard
    // restores `deps?.onMerge?.(taskId) ?? options?.onMerge`, which no longer matches this literal and so
    // fails as both an uncovered hit and a stale entry.
    literal: ": options?.onMerge ?? ((id: string) => scopedStore.mergeTask(id));",
    shape: "launch-callback-dispatch",
    reason: "The sanctioned merge leg, reachable only when launchScoped is true (unscoped, the launch project's own id, or a --no-engine host). Guarded upstream by `if (!launchScoped && projectId)`.",
  },
  {
    file: "register-chat-routes.ts",
    literal: "?? options?.engineManager?.getEngine(projectId)",
    shape: "launch-option-fallthrough",
    reason: "Falls back to a per-project lookup on the launch engine MANAGER, not to a launch-project object: still the requested project's engine.",
  },
  {
    file: "register-chat-routes.ts",
    literal: "?? options?.pluginRunner",
    shape: "launch-option-fallthrough",
    reason: "RESIDUAL: the process-level plugin runner is a capability, not project data. Recorded on the card's surface audit as unfixed because a per-project runner does not exist to fall back to.",
  },
  {
    file: "register-settings-memory-routes.ts",
    literal: "getAllEngines().values().next().value",
    shape: "first-engine-as-project-data",
    reason: "RESIDUAL: the backup routine is registered on ONE process-wide routine store, so the first live engine genuinely is its owner. Named in the card's surface-audit residuals; it is not a per-request project read.",
  },
  {
    file: "register-settings-memory-routes.ts",
    literal: "for (const engine of engineManager.getAllEngines().values())",
    shape: "every-engine-broadcast",
    reason: "Fan-out that pushes a process-global runtime change to EVERY project, so no project is substituted for another - which is the opposite of the borrow this ratchet refuses.",
  },
  {
    // The literal names the callback, not a line: each toggle has one guard line and one call line, and
    // the sanction is a property of the callback (process-global), not of the line it is written on.
    file: "register-settings-memory-routes.ts",
    literal: "onUseClaudeCliToggled",
    shape: "launch-callback-dispatch",
    reason: "Process-global runtime toggle (one Claude CLI per process), not project data.",
  },
  {
    file: "register-settings-memory-routes.ts",
    literal: "onUseDroidCliToggled",
    shape: "launch-callback-dispatch",
    reason: "Process-global runtime toggle (one Droid CLI per process), not project data.",
  },
  {
    file: "register-settings-memory-routes.ts",
    literal: "onUseLlamaCppToggled",
    shape: "launch-callback-dispatch",
    reason: "Process-global runtime toggle (one llama.cpp runtime per process), not project data.",
  },
  {
    file: "register-auth-routes.ts",
    literal: "for (const engine of engineManager.getAllEngines().values())",
    shape: "every-engine-broadcast",
    reason: "Fan-out that pushes a process-global runtime change to EVERY project; no project is substituted for another.",
  },
  {
    file: "register-auth-routes.ts",
    literal: "onUseClaudeCliToggled",
    shape: "launch-callback-dispatch",
    reason: "Process-global runtime toggle (one Claude CLI per process), not project data.",
  },
  {
    file: "register-auth-routes.ts",
    literal: "onUseDroidCliToggled",
    shape: "launch-callback-dispatch",
    reason: "Process-global runtime toggle (one Droid CLI per process), not project data.",
  },
  {
    file: "register-auth-routes.ts",
    literal: "onUseLlamaCppToggled",
    shape: "launch-callback-dispatch",
    reason: "Process-global runtime toggle (one llama.cpp runtime per process), not project data.",
  },
  {
    file: "register-auth-routes.ts",
    literal: "onApiKeySaved",
    shape: "launch-callback-dispatch",
    reason: "Provider credentials live in the process-level runtime config; the daemon-wide reload callback has no per-project target to be confused with.",
  },
  {
    file: "register-project-routes.ts",
    literal: "onProjectRegistered",
    shape: "launch-callback-dispatch",
    reason: "Registration event for a project that by definition has no engine yet; the callback exists to tell the manager about it.",
  },
  {
    file: "register-git-github.ts",
    literal: "onConflictDetected",
    shape: "launch-callback-dispatch",
    reason: "RESIDUAL: the taskId is resolved through the scoped store, but the callback reaches the launch process's conflict notifier. Named in the card's surface-audit residuals; it notifies, it does not mutate a project.",
  },
  {
    file: "register-messaging-scripts.ts",
    literal: "for (const engine of engineManager.getAllEngines().values())",
    shape: "every-engine-broadcast",
    reason: "Fan-out that pushes a process-global change to EVERY project; no project is substituted for another.",
  },
  {
    file: "register-approval-routes.ts",
    literal: "?? ctx.options?.isDaemonAuthEnabled",
    shape: "launch-option-fallthrough",
    reason: "Daemon authentication is one process-wide flag; there is no per-project auth state to fall back from.",
  },
];

/** Every `register-*.ts` in the routes directory. */
function scanSources(): Array<{ file: string; code: string }> {
  return readdirSync(ROUTES_DIR)
    .filter((name) => /^register-.*\.ts$/.test(name))
    .map((file) => ({ file, code: readFileSync(`${ROUTES_DIR}/${file}`, "utf8") }));
}

/*
FNXC:ProjectTenancy 2026-11-19-21:40 (RUFU-518):
Stripping happens HERE, inside the collector, rather than at the caller: a scan that could be handed raw
source would silently start counting the fix's own comments as violations, and the first person to
"repair" that red would be scanning prose.
*/
function collectForbiddenHits(sources: Array<{ file: string; code: string }>): ForbiddenHit[] {
  const hits: ForbiddenHit[] = [];
  for (const { file, code } of sources) {
    const lines = stripComments(code).split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const shape = FORBIDDEN_SHAPES.find((candidate) => candidate.pattern.test(lines[index]));
      if (shape) {
        hits.push({ file, line: index + 1, shape: shape.id, text: normalize(lines[index]) });
      }
    }
  }
  return hits;
}

function uncoveredHits(hits: ForbiddenHit[]): ForbiddenHit[] {
  return hits.filter((hit) => !ALLOWLIST.some((entry) => entry.file === hit.file && hit.text.includes(entry.literal)));
}

function hitsForAllowlistEntry(hits: ForbiddenHit[], entry: AllowlistEntry): ForbiddenHit[] {
  return hits.filter((hit) => hit.file === entry.file && hit.text.includes(entry.literal));
}

const SOURCES = scanSources();
const ALL_HITS = collectForbiddenHits(SOURCES);

describe("RUFU-518 ratchet: a project-scoped route may not reach a launch-project object", () => {
  it("scans every register-*.ts route file, so the inventory is the real surface", () => {
    expect(SOURCES.length).toBeGreaterThanOrEqual(50);
    expect(SOURCES.map((source) => source.file)).toContain("register-task-workflow-routes.ts");
  });

  it("finds forbidden shapes in real source, so the scan is never vacuous", () => {
    // ~24 lines match today. A floor well under that still catches a scan that stopped reading, and a
    // ceiling is impossible without making the ratchet refuse legitimate allowlisted growth.
    expect(ALL_HITS.length).toBeGreaterThanOrEqual(15);
    expect(ALLOWLIST.length).toBeGreaterThan(0);
  });

  it("reports NO site outside the allowlist, naming file, line, shape and literal", () => {
    const unallowlisted = uncoveredHits(ALL_HITS);
    expect(
      unallowlisted.map((hit) => `${hit.file}:${hit.line} [${hit.shape}] ${hit.text}`),
      "A project-scoped route now reaches a launch-project object. If the site is genuinely process-global, add a reasoned allowlist entry; if it can act on another project's data, refuse it the way POST /tasks/:id/merge does.",
    ).toEqual([]);
  });

  it("carries no stale allowlist entry, because a ratchet trusts only entries that still bite", () => {
    const stale = ALLOWLIST.filter((entry) => hitsForAllowlistEntry(ALL_HITS, entry).length === 0);
    expect(
      stale.map((entry) => `${entry.file} :: ${entry.literal}`),
      "This entry sanctions a site that no longer exists in the scanned source. Delete it, and if it moved, rewrite the literal to the line that exists now.",
    ).toEqual([]);
  });

  it("pins each allowlist entry to the shape it claims, so a mislabel cannot hide a new class", () => {
    const mislabelled = ALLOWLIST.flatMap((entry) => hitsForAllowlistEntry(ALL_HITS, entry)
      .filter((hit) => hit.shape !== entry.shape)
      .map((hit) => `${entry.file}:${hit.line} declared ${entry.shape}, actually ${hit.shape}`));
    expect(mislabelled).toEqual([]);
  });

  it("classifies each shape that the fix relies on, so growth is attributed and not merely counted", () => {
    const shapesSeen = new Set(ALL_HITS.map((hit) => hit.shape));
    for (const shape of ["launch-callback-dispatch", "first-engine-as-project-data", "every-engine-broadcast", "launch-option-fallthrough"]) {
      expect(shapesSeen.has(shape), `no line matched ${shape}: either the class vanished or its pattern no longer matches`).toBe(true);
    }
  });
});

/*
FNXC:ProjectTenancy 2026-11-19-21:40 (RUFU-518):
The named-guard inventory. The allowlist above deliberately sanctions the merge route's launch leg by its
EXACT shape, so the guard that protects it must be pinned here too: deleting the guard rewrites that leg,
and both halves of this pair must not be able to drift apart unnoticed.
*/
describe("RUFU-518 ratchet: the guards the allowlist leans on are still present", () => {
  function stripped(name: string): string {
    return stripComments(readFileSync(`${ROUTES_DIR}/${name}`, "utf8"));
  }

  it("context.ts still owns the predicate and derives launchScoped once", () => {
    const code = normalize(stripped(CONTEXT_FILE));
    expect(code).toContain("export function namesForeignColdProject(");
    expect(code).toContain("const launchScoped = !namesForeignColdProject(projectId, options, store);");
    // The predicate's own derivation plus the automation store, routine store, and routine runner guards.
    const guardSites = code.split("namesForeignColdProject(").length - 1;
    expect(guardSites).toBeGreaterThanOrEqual(4);
  });

  it("the merge route still refuses before choosing a merge implementation", () => {
    const code = normalize(stripped("register-task-workflow-routes.ts"));
    expect(code).toContain("if (!launchScoped && projectId) {");
    expect(code).toContain("throw engineStartingError(projectId)");
  });

  it("the remote-URL sites still refuse instead of borrowing the launch tunnel", () => {
    const code = normalize(stripped("register-settings-memory-routes.ts"));
    expect(code).toContain("if (!context.launchScoped && context.projectId) {");
    expect(code).toContain("throw engineStartingError(context.projectId)");
  });

  it("launchScoped stays a required field, so no context can be built without deciding it", () => {
    expect(normalize(stripped("types.ts"))).toContain("launchScoped: boolean;");
  });
});

describe("RUFU-518 ratchet: mutated-fixture controls", () => {
  it("a planted engine-less callback dispatch is reported with its file, line and shape", () => {
    const planted = [{
      file: "register-planted-routes.ts",
      code: [
        "export function registerPlantedRoutes(ctx: ApiRoutesContext, deps: ServerOptions) {",
        "  const merge = deps?.onMerge?.(task.id);",
        "  const runner = resolveRunner(projectId) ?? options?.routineRunner;",
        "}",
      ].join("\n"),
    }];

    const reported = uncoveredHits(collectForbiddenHits(planted));

    expect(reported.map((hit) => `${hit.file}:${hit.line} [${hit.shape}]`)).toEqual([
      "register-planted-routes.ts:2 [launch-callback-dispatch]",
      "register-planted-routes.ts:3 [launch-option-fallthrough]",
    ]);
  });

  it("the control: reverting the merge guard's launch leg to the pre-fix shape makes it report, and the real file stays silent", () => {
    const sanctioned = ": options?.onMerge ?? ((id: string) => scopedStore.mergeTask(id));";
    // The pre-fix shape: an engine-less callback dispatch, which is what answered "not found".
    const preFix = "const merge = deps?.onMerge?.(taskId) ?? options?.onMerge ?? ((id: string) => scopedStore.mergeTask(id));";

    const mergeSource = SOURCES.find((source) => source.file === "register-task-workflow-routes.ts");
    expect(mergeSource).toBeDefined();
    expect(mergeSource!.code).toContain(sanctioned);

    const reverted = [{ file: mergeSource!.file, code: mergeSource!.code.replace(sanctioned, preFix) }];
    const reported = uncoveredHits(collectForbiddenHits(reverted));
    expect(reported.length).toBeGreaterThan(0);
    expect(reported.map((hit) => hit.text)).toContain(preFix);
    // And the same collector over the real, fixed file finds nothing outside the allowlist.
    expect(uncoveredHits(collectForbiddenHits([mergeSource!]))).toEqual([]);
  });

  it("comment prose quoting the forbidden shape is not counted as a violation", () => {
    const documented = [{
      file: "register-planted-routes.ts",
      code: [
        "/*",
        "FNXC:ProjectTenancy 2026-11-19-21:40 (RUFU-518):",
        "Dropping only the `options?.onMerge` leg would be worse than the defect.",
        "*/",
        "  const runner = resolveRunner(projectId) ?? options?.routineRunner;",
      ].join("\n"),
    }];

    const reported = uncoveredHits(collectForbiddenHits(documented));

    // One hit, from the CODE line - the quoted callback inside the comment is documentation, not a call.
    expect(reported).toHaveLength(1);
    expect(reported[0].line).toBe(5);
  });
});
