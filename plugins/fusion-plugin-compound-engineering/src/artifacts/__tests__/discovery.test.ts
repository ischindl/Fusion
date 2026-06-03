import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as realFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock node:fs so we can observe/inject behaviour around readFileSync and
// accessSync without relying on vi.spyOn (ESM namespace exports are not
// configurable). The list scan probes readability with accessSync (no bytes
// read); readFileSync is only used when an artifact's content is actually
// fetched (readArtifactById). The hooks below default to passthrough and
// individual tests override them.
let readFileHook: ((path: realFs.PathOrFileDescriptor, original: typeof realFs.readFileSync, args: unknown[]) => unknown) | undefined;
let accessHook: ((path: realFs.PathLike, original: typeof realFs.accessSync, args: unknown[]) => unknown) | undefined;

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof realFs>();
  return {
    ...actual,
    readFileSync: (path: realFs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (readFileHook) return readFileHook(path, actual.readFileSync, args);
      return (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...args);
    },
    accessSync: (path: realFs.PathLike, ...args: unknown[]) => {
      if (accessHook) return accessHook(path, actual.accessSync, args);
      return (actual.accessSync as (...a: unknown[]) => unknown)(path, ...args);
    },
  };
});

const { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } = realFs;
const { discoverArtifacts, readArtifactById } = await import("../discovery.js");

function makeRepo(): string {
  return mkdtempSync(join(tmpdir(), "ce-discovery-"));
}

describe("discoverArtifacts", () => {
  let root: string;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    readFileHook = undefined;
    accessHook = undefined;
    vi.restoreAllMocks();
  });

  it("returns grouped artifacts from a fixture repo tree (happy path)", () => {
    root = makeRepo();
    writeFileSync(join(root, "STRATEGY.md"), "# Strategy");
    writeFileSync(join(root, "CONCEPTS.md"), "# Concepts");
    mkdirSync(join(root, "docs/ideation"), { recursive: true });
    writeFileSync(join(root, "docs/ideation/a.md"), "ideation a");
    writeFileSync(join(root, "docs/ideation/b.md"), "ideation b");
    mkdirSync(join(root, "docs/brainstorms"), { recursive: true });
    writeFileSync(join(root, "docs/brainstorms/x.md"), "brainstorm x");
    mkdirSync(join(root, "docs/plans"), { recursive: true });
    writeFileSync(join(root, "docs/plans/plan1.md"), "plan 1");
    mkdirSync(join(root, "docs/solutions"), { recursive: true });
    writeFileSync(join(root, "docs/solutions/sol.md"), "solution");

    const result = discoverArtifacts(root);
    const byStage = Object.fromEntries(result.groups.map((g) => [g.stage, g]));

    expect(result.totalArtifacts).toBe(7);
    expect(result.totalErrors).toBe(0);
    expect(byStage.strategy.entries).toHaveLength(1);
    expect(byStage.concepts.entries).toHaveLength(1);
    expect(byStage.ideation.entries).toHaveLength(2);
    expect(byStage.brainstorm.entries).toHaveLength(1);
    expect(byStage.plan.entries).toHaveLength(1);
    expect(byStage.solution.entries).toHaveLength(1);
    // Every group present is flagged present.
    expect(byStage.ideation.present).toBe(true);
    // All entries are artifacts in the happy path.
    expect(result.groups.flatMap((g) => g.entries).every((e) => e.kind === "artifact")).toBe(true);
  });

  it("orders directory artifacts by updatedAt DESC", () => {
    root = makeRepo();
    mkdirSync(join(root, "docs/plans"), { recursive: true });
    const older = join(root, "docs/plans/old.md");
    const newer = join(root, "docs/plans/new.md");
    writeFileSync(older, "old");
    writeFileSync(newer, "new");
    // Force deterministic mtimes: old < new.
    const now = Date.now();
    utimesSync(older, new Date(now - 10_000), new Date(now - 10_000));
    utimesSync(newer, new Date(now), new Date(now));

    const result = discoverArtifacts(root);
    const plan = result.groups.find((g) => g.stage === "plan")!;
    expect(plan.entries.map((e) => e.name)).toEqual(["new.md", "old.md"]);
  });

  it("reports a partial-discovery state: some categories present, others empty", () => {
    root = makeRepo();
    writeFileSync(join(root, "STRATEGY.md"), "# Strategy");
    mkdirSync(join(root, "docs/plans"), { recursive: true });
    writeFileSync(join(root, "docs/plans/p.md"), "plan");
    // No ideation / brainstorms / solutions / CONCEPTS.

    const result = discoverArtifacts(root);
    const populated = result.groups.filter((g) => g.entries.length > 0);
    const empty = result.groups.filter((g) => g.entries.length === 0);
    expect(populated.map((g) => g.stage).sort()).toEqual(["plan", "strategy"]);
    expect(empty.length).toBeGreaterThan(0);
    // Empty groups are still present in the result so the hub can render them.
    expect(result.groups).toHaveLength(6);
  });

  it("returns an all-empty result when nothing is present (first-run)", () => {
    root = makeRepo();
    const result = discoverArtifacts(root);
    expect(result.totalArtifacts).toBe(0);
    expect(result.totalErrors).toBe(0);
    expect(result.groups.every((g) => g.entries.length === 0 && !g.present)).toBe(true);
  });

  it("represents an unreadable artifact as an error entry, not a crash or silent drop", () => {
    root = makeRepo();
    mkdirSync(join(root, "docs/plans"), { recursive: true });
    const readable = join(root, "docs/plans/good.md");
    writeFileSync(readable, "good");

    // Simulate a malformed/unreadable artifact: the specific file throws when
    // the list scan probes readability (accessSync).
    accessHook = (path, original, args) => {
      if (typeof path === "string" && path.endsWith("good.md")) {
        throw new Error("EIO: simulated read failure");
      }
      return (original as (...a: unknown[]) => unknown)(path, ...args);
    };

    const result = discoverArtifacts(root);
    const plan = result.groups.find((g) => g.stage === "plan")!;
    expect(plan.entries).toHaveLength(1);
    const entry = plan.entries[0];
    expect(entry.kind).toBe("error");
    expect(entry.kind === "error" && entry.error).toContain("simulated read failure");
    expect(result.totalErrors).toBe(1);
    expect(result.totalArtifacts).toBe(0);
  });

  it("ignores unrelated files and does not read outside the conventional locations", () => {
    root = makeRepo();
    // Conventional artifact that SHOULD be read.
    writeFileSync(join(root, "STRATEGY.md"), "# Strategy");
    mkdirSync(join(root, "docs/ideation"), { recursive: true });
    writeFileSync(join(root, "docs/ideation/keep.md"), "keep");
    // Unrelated files that must NOT be read.
    writeFileSync(join(root, "README.md"), "readme"); // root-level non-conventional .md
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(root, "docs/ideation/notes.txt"), "non-md, ignore"); // non-.md in a scanned dir
    mkdirSync(join(root, "secrets"), { recursive: true });
    writeFileSync(join(root, "secrets/secret.md"), "TOP SECRET"); // outside the allowlist
    mkdirSync(join(root, "docs/random"), { recursive: true });
    writeFileSync(join(root, "docs/random/r.md"), "unrelated"); // docs subtree but not conventional

    const opened: string[] = [];
    // The list scan probes readability with accessSync (no bytes read); track
    // exactly which paths it touches.
    accessHook = (path, original, args) => {
      if (typeof path === "string") opened.push(path);
      return (original as (...a: unknown[]) => unknown)(path, ...args);
    };

    const result = discoverArtifacts(root);

    // Only the two conventional artifacts were probed.
    expect(opened.some((p) => p.endsWith("STRATEGY.md"))).toBe(true);
    expect(opened.some((p) => p.endsWith(join("ideation", "keep.md")))).toBe(true);
    // Nothing outside the allowlist was opened.
    expect(opened.some((p) => p.includes(`${join("secrets", "secret.md")}`))).toBe(false);
    expect(opened.some((p) => p.endsWith("README.md"))).toBe(false);
    expect(opened.some((p) => p.endsWith("package.json"))).toBe(false);
    expect(opened.some((p) => p.endsWith("notes.txt"))).toBe(false);
    expect(opened.some((p) => p.includes(join("random", "r.md")))).toBe(false);

    expect(result.totalArtifacts).toBe(2);
  });
});

describe("readArtifactById", () => {
  let root: string;

  beforeEach(() => {
    root = makeRepo();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reads a conventional file artifact", () => {
    writeFileSync(join(root, "STRATEGY.md"), "# Strategy body");
    const res = readArtifactById(root, "strategy:STRATEGY.md");
    expect(res).toBeDefined();
    expect(res && "content" in res && res.content).toContain("Strategy body");
  });

  it("reads a directory artifact's immediate Markdown child", () => {
    mkdirSync(join(root, "docs/plans"), { recursive: true });
    writeFileSync(join(root, "docs/plans/p.md"), "plan body");
    const res = readArtifactById(root, "plan:docs/plans/p.md");
    expect(res && "content" in res && res.content).toBe("plan body");
  });

  it("refuses a forged id that escapes the conventional location", () => {
    writeFileSync(join(root, "secrets.md"), "secret");
    // Attempt to traverse out of docs/plans into the repo root.
    expect(readArtifactById(root, "plan:../../secrets.md")).toBeUndefined();
    // Wrong stage/path pairing for a file location.
    expect(readArtifactById(root, "strategy:CONCEPTS.md")).toBeUndefined();
    // Unknown stage.
    expect(readArtifactById(root, "bogus:whatever.md")).toBeUndefined();
  });

  it("refuses a nested path under a directory location (non-immediate child)", () => {
    mkdirSync(join(root, "docs/plans/sub"), { recursive: true });
    writeFileSync(join(root, "docs/plans/sub/deep.md"), "deep");
    expect(readArtifactById(root, "plan:docs/plans/sub/deep.md")).toBeUndefined();
  });
});
