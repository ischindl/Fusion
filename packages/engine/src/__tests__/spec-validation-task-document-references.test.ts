import { describe, expect, it } from "vitest";
import { detectDanglingTaskDocReferences, formatDanglingDiagnostic } from "../spec-validation/task-document-references.js";

describe("detectDanglingTaskDocReferences", () => {
  it("flags FN-5110-style missing artifact references", async () => {
    const prompt = "## Context to Read First\n- `.fusion/tasks/FN-5110/failure-inventory.md`\n\n## Steps\n### Step 0: Preflight\n- Read .fusion/tasks/FN-5110/failure-inventory.md\n\n### Step 4: Verify\n- Use (.fusion/tasks/FN-5110/failure-inventory.md)\n\n### Step 5: Delivery\n- Final check: `.fusion/tasks/FN-5110/failure-inventory.md`";
    const refs = await detectDanglingTaskDocReferences(prompt, {
      rootDir: "/tmp/project",
      taskId: "FN-5112",
      existsImpl: async () => false,
    });

    expect(refs).toEqual([
      {
        path: ".fusion/tasks/FN-5110/failure-inventory.md",
        sections: ["Context to Read First", "Step 0", "Step 4", "Step 5", "Steps"],
      },
    ]);
  });

  it("ignores sibling PROMPT.md and task.json references", async () => {
    const prompt = `## Context to Read First\n- .fusion/tasks/FN-9999/PROMPT.md\n- .fusion/tasks/FN-9999/task.json`;
    const refs = await detectDanglingTaskDocReferences(prompt, {
      rootDir: "/tmp/project",
      taskId: "FN-5112",
      existsImpl: async () => false,
    });
    expect(refs).toEqual([]);
  });

  it("does not flag (new) artifacts", async () => {
    const prompt = "## Steps\n### Step 1: Create inventory\n- Read .fusion/tasks/FN-5112/failure-inventory.md\n\n**Artifacts:**\n- `.fusion/tasks/FN-5112/failure-inventory.md` (new)";
    const refs = await detectDanglingTaskDocReferences(prompt, {
      rootDir: "/tmp/project",
      taskId: "FN-5112",
      existsImpl: async () => false,
    });
    expect(refs).toEqual([]);
  });

  it("does not flag paths listed in file scope", async () => {
    const prompt = "## File Scope\n- `.fusion/tasks/FN-5112/failure-inventory.md`\n\n## Steps\n### Step 1: Read\n- .fusion/tasks/FN-5112/failure-inventory.md";
    const refs = await detectDanglingTaskDocReferences(prompt, {
      rootDir: "/tmp/project",
      taskId: "FN-5112",
      existsImpl: async () => false,
    });
    expect(refs).toEqual([]);
  });

  it("returns empty when all candidates exist", async () => {
    const prompt = `## Steps\n### Step 1: Read\n- .fusion/tasks/FN-9999/notes.md`;
    const refs = await detectDanglingTaskDocReferences(prompt, {
      rootDir: "/tmp/project",
      taskId: "FN-5112",
      existsImpl: async () => true,
    });
    expect(refs).toEqual([]);
  });

  it("parses wrapped and punctuated path tokens", async () => {
    const prompt = "## Steps\n### Step 1: Parse\n- (`.fusion/tasks/FN-9999/notes%20encoded.md`),\n- '.fusion/tasks/FN-9999/path(with)-parens.md'.";

    const refs = await detectDanglingTaskDocReferences(prompt, {
      rootDir: "/tmp/project",
      taskId: "FN-5112",
      existsImpl: async () => false,
    });

    expect(refs.map((r) => r.path)).toEqual([
      ".fusion/tasks/FN-9999/notes%20encoded.md",
      ".fusion/tasks/FN-9999/path(with)-parens.md",
    ]);
  });

  it("formats revise diagnostics", async () => {
    const formatted = formatDanglingDiagnostic([
      { path: ".fusion/tasks/FN-5110/failure-inventory.md", sections: ["Step 0", "Step 4", "Step 5"] },
    ]);
    expect(formatted).toContain("REVISE — Dangling task-document references");
    expect(formatted).toContain("Step 0, Step 4, Step 5");
  });
});

/*
FNXC:SpecValidationPathTail 2026-11-08-03:06 (RUFU-485) — Symptom Verification repro (a):
RUFU-482's planner wrote a scanned-section note pointing at its own task folder with a U+2026 ellipsis
as the "file part". The checker read that ellipsis as a file name, refused the spec, and the planner
regenerated the identical sentence: 3 attempts, 3 identical refusals, then an ownerless park. These cases
pin the whole tolerance matrix, in BOTH directions: the ellipsis note must stop firing, and a genuinely
dangling cross-task file path must keep firing, or the checker has been defanged instead of fixed.

The fake filesystem models what actually exists on disk: every task DIRECTORY exists, plus the files
listed in `existingFiles`. `abs.endsWith("/")` is how a directory citation arrives.
*/
describe("detectDanglingTaskDocReferences — path tail normalization (RUFU-485)", () => {
  const ELLIPSIS = "\u2026";
  const existingFiles = new Set<string>([
    ".fusion/tasks/RUFU-482/PROMPT.md",
    ".fusion/tasks/RUFU-482/task.json",
    ".fusion/tasks/RUFU-482/attachments/note.png",
    ".fusion/tasks/RUFU-482/inventory.md",
    ".fusion/tasks/RUFU-485/PROMPT.md",
  ]);

  const exists = async (absPath: string): Promise<boolean> => {
    const rel = absPath.replace("/tmp/project/", "");
    if (rel.endsWith("/")) return rel.slice(0, -1) === ".fusion/tasks/RUFU-482" || rel.slice(0, -1) === ".fusion/tasks/RUFU-485";
    return existingFiles.has(rel);
  };

  const detect = (prompt: string, taskId = "RUFU-485") =>
    detectDanglingTaskDocReferences(prompt, { rootDir: "/tmp/project", taskId, existsImpl: exists });

  const scannedNote = (token: string) =>
    `## Context to Read First\n- Read the sibling card's folder: \`${token}\`\n\n## Steps\n### Step 0: Preflight\n- Nothing else cited.\n`;

  it("does not flag RUFU-482's ellipsis directory note (the exact failing line)", async () => {
    expect(await detect(scannedNote(`.fusion/tasks/RUFU-482/${ELLIPSIS}`))).toEqual([]);
  });

  it("treats a U+2026 tail exactly like the tolerated ASCII ellipsis", async () => {
    expect(await detect(scannedNote(`.fusion/tasks/RUFU-482/...`))).toEqual([]);
    expect(await detect(scannedNote(`.fusion/tasks/RUFU-482/${ELLIPSIS}`))).toEqual([]);
    expect(await detect(scannedNote(`.fusion/tasks/RUFU-482/${ELLIPSIS}${ELLIPSIS}${ELLIPSIS}`))).toEqual([]);
  });

  it("tolerates the ellipsis tail for the card's own task directory too", async () => {
    expect(await detect(scannedNote(`.fusion/tasks/RUFU-485/${ELLIPSIS}`))).toEqual([]);
  });

  it("tolerates an ellipsis tail on a real sibling artifact name", async () => {
    expect(await detect(scannedNote(`.fusion/tasks/RUFU-482/PROMPT.md${ELLIPSIS}`))).toEqual([]);
    expect(await detect(scannedNote(`.fusion/tasks/RUFU-482/task.json${ELLIPSIS}`))).toEqual([]);
    expect(await detect(scannedNote(`.fusion/tasks/RUFU-482/attachments/${ELLIPSIS}`))).toEqual([]);
  });

  it("still flags a genuinely dangling cross-task non-sibling file (regression direction)", async () => {
    const refs = await detect(scannedNote(`.fusion/tasks/RUFU-482/delivered-evidence.md${ELLIPSIS}`));
    expect(refs.map((r) => r.path)).toEqual([".fusion/tasks/RUFU-482/delivered-evidence.md"]);
  });

  it("still flags an ellipsis that sits INSIDE a path segment (it still claims a file name)", async () => {
    const refs = await detect(scannedNote(`.fusion/tasks/RUFU-482/notes${ELLIPSIS}inventory.md`));
    expect(refs.map((r) => r.path)).toEqual([`.fusion/tasks/RUFU-482/notes${ELLIPSIS}inventory.md`]);
  });

  it("still flags a dangling cross-task directory note whose directory does not exist", async () => {
    const refs = await detect(scannedNote(`.fusion/tasks/RUFU-9999/${ELLIPSIS}`));
    expect(refs.map((r) => r.path)).toEqual([".fusion/tasks/RUFU-9999/"]);
  });

  it("never captures the non-capturable placeholder form (angle-bracket id)", async () => {
    expect(await detect(scannedNote(`.fusion/tasks/<TARGET_ID>/${ELLIPSIS}`))).toEqual([]);
    expect(await detect(scannedNote(".fusion/tasks/<TARGET_ID>/anything.md"))).toEqual([]);
  });

  it("ignores an ellipsis token outside the two scanned sections", async () => {
    const prompt = `## What This Delivers\n- A note about \`.fusion/tasks/RUFU-9999/${ELLIPSIS}\` and a real dangling \`.fusion/tasks/RUFU-9999/gone.md\`.\n\n## Steps\n### Step 0: Preflight\n- Nothing cited here.\n`;
    expect(await detect(prompt)).toEqual([]);
  });

  it("reports scanned-section attribution unchanged for a mixed citation set", async () => {
    const prompt = `## Context to Read First\n- \`.fusion/tasks/RUFU-482/${ELLIPSIS}\`\n- \`.fusion/tasks/RUFU-482/missing.md\`\n\n## Steps\n### Step 0: Preflight\n- \`.fusion/tasks/RUFU-482/missing.md\`\n`;
    const refs = await detect(prompt);
    expect(refs).toEqual([
      { path: ".fusion/tasks/RUFU-482/missing.md", sections: ["Context to Read First", "Step 0", "Steps"] },
    ]);
  });

  it("keeps the (new) artifact exception working for an ellipsis-free own-task artifact", async () => {
    const prompt = "## Steps\n### Step 1: Write\n- Read .fusion/tasks/RUFU-485/notes.md\n\n**Artifacts:**\n- `.fusion/tasks/RUFU-485/notes.md` (new)";
    expect(await detect(prompt)).toEqual([]);
  });

  it("keeps the (new) exception strict: an Artifacts line without (new) is not an exception", async () => {
    const prompt = "## Steps\n### Step 1: Write\n- Read .fusion/tasks/RUFU-9999/notes.md\n\n**Artifacts:**\n- never `git add -f .fusion/tasks/RUFU-9999/notes.md`";
    const refs = await detect(prompt);
    expect(refs.map((r) => r.path)).toContain(".fusion/tasks/RUFU-9999/notes.md");
  });
});
