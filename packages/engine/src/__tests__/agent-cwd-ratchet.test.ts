/**
 * RUFU-334 — the working-directory ratchet: no agent lane may inherit the server's launch directory.
 *
 * Why a scan and not a review note: the incident was nine lanes each carrying their own
 * `?? process.cwd()` default while only the one that leaked (the dashboard Usage probe, which spawned a
 * write-granted interactive `claude` REPL with `--add-dir <serve root>`) was ever noticed. A fix that is
 * verified per-file regresses the same way, so this guard enumerates every remaining `process.cwd()`
 * read in production source across the three packages that host agent lanes and refuses an un-audited
 * new one. Everything here is structural — call expressions and string literals read through the
 * TypeScript parser, so comments are invisible to it by construction and the guard can never be
 * satisfied by writing a comment.
 *
 * FNXC:AgentWorkingDirectoryPolicy 2026-10-18-13:29 (RUFU-334):
 * Identity is file + the trimmed source line, matched with a per-key COUNT; the line number in the
 * allowlist is documentation. That is deliberate and copies `engine-no-blocking-shellout.test.ts`, whose
 * line-keyed version produced three false failures: re-pinning a guard on unrelated edits trains people
 * to re-pin it without reading it, which is how a real new read slips through in the same commit. The
 * count still catches a second identical read added to an audited file.
 *
 * FNXC:AgentWorkingDirectoryPolicy 2026-10-18-13:05 (RUFU-334):
 * Test scope is excluded by construction (`__tests__/` directories plus `*.test.*`/`*.spec.*` files),
 * because a test's `rootDir: process.cwd()` anchor is not a lane: the ~150 engine test uses would bury the
 * three production hits this card enumerated, and an allowlist that long stops being reviewable. Production
 * source in all three packages is scanned in full — including `packages/engine/src/cli-agent/`, which hosts
 * the PTY lane.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSourceFile,
  forEachChild,
  isBinaryExpression,
  isCallExpression,
  isIdentifier,
  isPropertyAccessExpression,
  isStringLiteralLike,
  ScriptTarget,
  SyntaxKind,
  type SourceFile,
} from "typescript";

type CwdSite = {
  /** Repo-relative path, e.g. `packages/engine/src/agent-heartbeat.ts`. */
  file: string;
  /** Documentation only — see the FNXC note above. */
  line: number;
  /** The trimmed source line the read sits on; this is the identity that must be audited. */
  signature: string;
};

type AllowlistEntry = CwdSite & { reason: string };

const ENGINE_PACKAGE_ROOT = process.cwd();
const REPO_ROOT = resolve(ENGINE_PACKAGE_ROOT, "..", "..");

/** Packages that can start an agent session or a CLI child process on an agent's behalf. */
const SCAN_ROOTS = [
  "packages/engine/src",
  "packages/dashboard/src",
  // Package root as well as `src/`: `index.ts` is the extension entry point that latches the session cwd.
  "packages/pi-claude-cli",
];

/**
 * Read-only / non-agent sites, each carrying the evidence that makes it safe. None of these is a spawn or
 * session root: they read configuration, rank known projects, or manage pi's own extension settings.
 * `agent-heartbeat.ts` and the pi SettingsManager routes are write-capable roots for NON-agent tool
 * surfaces; both are recorded in this card's findings as follow-up cards rather than silently allowed.
 */
const READ_ONLY = "read-only; never a spawn or session cwd";
const FOLLOW_UP_NON_AGENT = "non-agent surface at the serve root; RUFU-334 records it as a follow-up card";

const ALLOW_LIST: AllowlistEntry[] = [
  {
    file: "packages/engine/src/auto-recovery-handlers/branch-worktree.ts",
    line: 133,
    signature: "return process.cwd();",
    reason: "read-only git plumbing (integration-branch inference and branch-collision checks), and the last resort after the failure evidence and the task worktree rev-parse --show-toplevel both fail; no session, PTY, or agent. " + READ_ONLY,
  },
  {
    file: "packages/engine/src/agent-heartbeat.ts",
    line: 5376,
    signature: "const rootDir = this.rootDir ?? process.cwd();",
    reason: `Root handed to \`createResearchTools\` for artifact writes. Not a session cwd, so it is outside this invariant, but it is a write-capable root and RUFU-334 files it as a follow-up: ${FOLLOW_UP_NON_AGENT}`,
  },
  {
    file: "packages/engine/src/project-engine.ts",
    line: 4268,
    signature: "return this.config?.workingDirectory ?? process.cwd();",
    reason: `Returned by \`resolveAdvisorCwd\` and consumed only by \`OverseerAdvisorService.discoverOverseerWatchdogFiles({ cwd })\`. ${READ_ONLY}`,
  },
  {
    file: "packages/dashboard/src/auth-paths.ts",
    line: 27,
    signature: "cwd = process.cwd(),",
    reason: `Default parameter of auth-file candidate discovery. ${READ_ONLY}`,
  },
  {
    file: "packages/dashboard/src/llama-cpp-probe.ts",
    line: 67,
    signature: "const cwd = options.cwd ?? process.cwd();",
    reason: `Resolved into a local server URL from config; no child process and no writes. ${READ_ONLY}`,
  },
  {
    file: "packages/dashboard/src/routes/register-setup-activity-routes.ts",
    line: 202,
    signature: "const detectedProjects = await detector.detectExistingProjects(process.cwd());",
    reason: `First-run project detection. ${READ_ONLY}`,
  },
  {
    file: "packages/dashboard/src/routes/register-setup-activity-routes.ts",
    line: 238,
    signature: "const detectedProjects = await detector.detectExistingProjects(process.cwd());",
    reason: `First-run project detection (second route). ${READ_ONLY}`,
  },
  {
    file: "packages/dashboard/src/routes/register-git-github.ts",
    line: 2268,
    signature: 'const rootDir = typeof store.getRootDir === "function" ? store.getRootDir() : process.cwd();',
    reason: `Read-only repository lookup that already prefers \`store.getRootDir()\`. ${READ_ONLY}`,
  },
  {
    file: "packages/dashboard/src/routes/register-plugins-automation.ts",
    line: 1126,
    signature: "const absoluteRequestPath = isAbsolute(requestPath) ? requestPath : resolve(process.cwd(), requestPath);",
    reason: `Expands an operator-supplied relative plugin path; never handed to a child process as its cwd. ${READ_ONLY}`,
  },
  {
    file: "packages/dashboard/src/routes/context.ts",
    line: 300,
    signature: "const cwd = resolve(process.cwd());",
    reason: `Ranks known projects by proximity for a list response. ${READ_ONLY}`,
  },
  {
    file: "packages/dashboard/src/routes/register-config-mcp-pi-settings-routes.ts",
    line: 215,
    signature: "const settingsManager = SettingsManager.create(process.cwd(), agentDir);",
    reason: `Operator-facing pi extension/settings management rooted at the serve directory. Not an AI-agent session, so outside this invariant; it is a write-capable root and RUFU-334 files it: ${FOLLOW_UP_NON_AGENT}`,
  },
  {
    file: "packages/dashboard/src/routes/register-config-mcp-pi-settings-routes.ts",
    line: 244,
    signature: "const settingsManager = SettingsManager.create(process.cwd(), agentDir);",
    reason: `Second settings route, same shape as the audited site above: ${FOLLOW_UP_NON_AGENT}`,
  },
  {
    file: "packages/dashboard/src/routes/register-config-mcp-pi-settings-routes.ts",
    line: 282,
    signature: "const cwd = process.cwd();",
    reason: `Local for the package-manager route below: ${FOLLOW_UP_NON_AGENT}`,
  },
  {
    file: "packages/dashboard/src/routes/register-config-mcp-pi-settings-routes.ts",
    line: 283,
    signature: "const settingsManager = SettingsManager.create(process.cwd(), agentDir);",
    reason: `Extension-management route: ${FOLLOW_UP_NON_AGENT}`,
  },
  {
    file: "packages/dashboard/src/routes/register-config-mcp-pi-settings-routes.ts",
    line: 306,
    signature: "const cwd = process.cwd();",
    reason: `Local for the package-manager route below: ${FOLLOW_UP_NON_AGENT}`,
  },
  {
    file: "packages/dashboard/src/routes/register-config-mcp-pi-settings-routes.ts",
    line: 307,
    signature: "const settingsManager = SettingsManager.create(process.cwd(), agentDir);",
    reason: "Package-management route (DefaultPackageManager), write-capable for pi extension installs, still not an AI-agent session: " + FOLLOW_UP_NON_AGENT,
  },
];

/** The card's own fixed paths: none of them may carry a `?? process.cwd()` default again. */
const FIXED_PATHS = [
  "packages/pi-claude-cli/src/provider.ts",
  "packages/pi-claude-cli/src/process-manager.ts",
  "packages/pi-claude-cli/src/acp-driver.ts",
  "packages/engine/src/cli-agent/session-manager.ts",
  "packages/dashboard/src/routes/automation-step-execution.ts",
  "packages/engine/src/executor/review-arbitration.ts",
  "packages/engine/src/scheduling/cron-runner.ts",
  "packages/engine/src/sandbox/sandbox-exec-backend.ts",
];

function isProcessCwdCall(node: Parameters<typeof forEachChild>[0]): boolean {
  if (!isCallExpression(node)) return false;
  const target = node.expression;
  if (!isPropertyAccessExpression(target)) return false;
  return isIdentifier(target.expression) && target.expression.text === "process" && target.name.text === "cwd";
}

/** Every production `process.cwd()` read, and every `?? process.cwd()` default, found through the parser. */
function scanSource(relativePath: string, source: string): { sites: CwdSite[]; fallbacks: CwdSite[] } {
  // The parser sees no comments and no test-only helper, so documentation about the old behaviour can
  // neither satisfy nor trip this guard.
  const sourceFile: SourceFile = createSourceFile(relativePath, source, ScriptTarget.Latest, false);
  const sites: CwdSite[] = [];
  const fallbacks: CwdSite[] = [];
  const record = (bucket: CwdSite[], node: Parameters<typeof forEachChild>[0]) => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    bucket.push({ file: relativePath, line: line + 1, signature: source.split("\n")[line].trim() });
  };
  const visit = (node: Parameters<typeof forEachChild>[0]): void => {
    if (isProcessCwdCall(node)) record(sites, node);
    if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.QuestionQuestionToken && isProcessCwdCall(node.right)) {
      record(fallbacks, node);
    }
    forEachChild(node, visit);
  };
  visit(sourceFile);
  return { sites, fallbacks };
}

function listProductionSource(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return ["__tests__", "node_modules", "dist", "coverage"].includes(entry.name) ? [] : listProductionSource(path);
    }
    if (!entry.isFile()) return [];
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) return [];
    return entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx") || entry.name.endsWith(".spec.ts") ? [] : [path];
  });
}

function scanAllRoots() {
  const scanned: string[] = [];
  const sites: CwdSite[] = [];
  for (const root of SCAN_ROOTS) {
    const absolute = join(REPO_ROOT, root);
    if (!existsSync(absolute)) scanned.push(`${root} MISSING`);
    scanned.push(root);
    sites.push(
      ...listProductionSource(absolute).flatMap((path) =>
        scanSource(relative(REPO_ROOT, path), readFileSync(path, "utf-8")).sites,
      ),
    );
  }
  return { scanned, sites };
}

function keyOf(entry: { file: string; signature: string }): string {
  return `${entry.file}:${entry.signature}`;
}

/** Two-sided match: a new un-audited read is unmatched, an audited read that moved away is stale. */
function classifySites(sites: CwdSite[], allowList: AllowlistEntry[] = ALLOW_LIST) {
  const budget = new Map<string, number>();
  for (const entry of allowList) budget.set(keyOf(entry), (budget.get(keyOf(entry)) ?? 0) + 1);
  const unmatched: CwdSite[] = [];
  for (const site of sites) {
    const key = keyOf(site);
    const remaining = budget.get(key) ?? 0;
    if (remaining > 0) budget.set(key, remaining - 1);
    else unmatched.push(site);
  }
  const stale = allowList.filter((entry) => (budget.get(keyOf(entry)) ?? 0) > 0);
  return { unmatched, stale };
}

function readRepoFile(repoPath: string): string {
  return readFileSync(join(REPO_ROOT, repoPath), "utf-8");
}

/** String and template literals only — the parser again, so a mention in a comment is not a hit. */
function stringsContaining(repoPath: string, needle: string): string[] {
  const source = readRepoFile(repoPath);
  const sourceFile = createSourceFile(repoPath, source, ScriptTarget.Latest, false);
  const hits: string[] = [];
  const visit = (node: Parameters<typeof forEachChild>[0]): void => {
    const literal =
      isStringLiteralLike(node) ||
      node.kind === SyntaxKind.NoSubstitutionTemplateLiteral ||
      node.kind === SyntaxKind.TemplateHead ||
      node.kind === SyntaxKind.TemplateMiddle
        ? node.getText(sourceFile)
        : null;
    if (literal?.includes(needle)) hits.push(literal);
    forEachChild(node, visit);
  };
  visit(sourceFile);
  return hits;
}

describe("RUFU-334 agent working-directory ratchet", () => {
  it("scans the package roots the card names, so a moved package fails loudly", () => {
    const { scanned } = scanAllRoots();
    expect(scanned.filter((root) => root.endsWith("MISSING"))).toEqual([]);
    expect(scanned).toEqual(SCAN_ROOTS);
  });

  it("confines every production process.cwd() read to the audited allowlist", () => {
    const { sites } = scanAllRoots();
    const { unmatched, stale } = classifySites(sites);

    // A new hit must name itself, not just fail an empty-array assertion.
    expect(unmatched.map((site) => `${site.file}:${site.line}: ${site.signature}`)).toEqual([]);
    expect(stale.map((entry) => `${entry.file}:${entry.line}`)).toEqual([]);
  });

  it("keeps the Claude runtime extension unable to read a launch directory at all", () => {
    // Strongest form of that package's contract: it is loaded inside the engine/dashboard process, so a
    // single process.cwd() read anywhere in it is a lane inheriting the server's directory.
    const extensionSites = scanAllRoots().sites.filter((site) => site.file.startsWith("packages/pi-claude-cli"));
    expect(extensionSites.map((site) => `${site.file}:${site.line}`)).toEqual([]);
  });

  it.each(FIXED_PATHS)("keeps no ?? process.cwd() default in %s", (repoPath) => {
    const { fallbacks } = scanSource(repoPath, readRepoFile(repoPath));
    expect(fallbacks.map((site) => `${site.file}:${site.line}: ${site.signature}`)).toEqual([]);
  });

  it("keeps the Usage probe from rooting a session at the server directory", () => {
    // Both halves of the incident: the launch-directory cwd, and the write grant on that same tree.
    const { sites } = scanSource("packages/dashboard/src/usage.ts", readRepoFile("packages/dashboard/src/usage.ts"));
    expect(sites.map((site) => `${site.file}:${site.line}: ${site.signature}`)).toEqual([]);
    expect(stringsContaining("packages/dashboard/src/usage.ts", "--add-dir")).toEqual([]);
  });

  it("flags an un-audited spawn root added to a scanned package", () => {
    const synthetic = 'const child = spawnSession({ cwd: process.cwd() });';
    const { sites } = scanSource("packages/dashboard/src/routes/synthetic-lane.ts", synthetic);

    expect(sites).toHaveLength(1);
    expect(classifySites(sites).unmatched).toEqual(sites);
  });

  it("flags a second identical read inside an audited file", () => {
    // This allowlist key is audited at a count of exactly one, so a duplicate is a real new read.
    const audited = ALLOW_LIST.find((entry) => entry.file.endsWith("auto-recovery-handlers/branch-worktree.ts"))!;
    const duplicated: CwdSite[] = [
      { file: audited.file, line: audited.line, signature: audited.signature },
      { file: audited.file, line: audited.line + 8, signature: audited.signature },
    ];

    expect(classifySites(duplicated).unmatched).toHaveLength(1);
  });

  it("does not count a mention of the old default in a comment", () => {
    // Regression guard for the guard: a comment about `process.cwd()` must not need an allowlist entry,
    // and must not be what makes this file pass.
    const documented = [
      "// The lane used to fall through to `process.cwd()` before RUFU-334.",
      "/* spawnSession({ cwd: process.cwd() }) was the old shape */",
      "export const ok = 1;",
    ].join("\n");

    expect(scanSource("packages/dashboard/src/routes/documented-lane.ts", documented).sites).toEqual([]);
  });
});
