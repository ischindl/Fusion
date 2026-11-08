import { access } from "node:fs/promises";
import { join } from "node:path";
import { matchStepHeadings } from "@fusion/core";
import { extractSection } from "../execution/step-session-executor.js";

export interface DanglingTaskDocReference {
  path: string;
  sections: string[];
}

export interface DetectDanglingOptions {
  rootDir: string;
  taskId: string;
  existsImpl?: (absPath: string) => Promise<boolean>;
}

const TASK_PATH_REGEX = /\.fusion\/tasks\/[A-Z0-9]+(?:-[A-Z0-9]+)*\/[^\s`'"\]]+/g;

/*
FNXC:SpecValidationPathTail 2026-11-08-03:06 (RUFU-485):
The tail class is terminal punctuation, not part of the cited file name. It already carried the ASCII
spread (backtick, brackets, parens, braces, quotes, comma, dot, semicolon, colon, bang, question mark)
because a spec sentence writes `` `…/notes.md`, `` and the trailing `.` of the sentence is not the file's.

It did not carry U+2026, the single-character ellipsis, and that omission cost three identical planning
refusals on RUFU-482: the planner wrote a scanned-section note pointing at the card's own task folder as
`.fusion/tasks/RUFU-482/…`, the capture class accepts any non-space character after the last slash, so
the "file part" of the token was the ellipsis itself — a token that cannot be read as a file name at all.
It is not a whitelisted sibling artifact, it does not exist on disk, so the checker REVISEd a spec whose
only sin was prose. Every planner regeneration produced the same sentence from the same input, so each of
the three attempts burned a session and failed on the same diagnostic.

The fix is the tail, exactly like the ASCII `...` that was always tolerated: strip a run of U+2026 and the
token normalizes to its containing directory, which exists, so a directory note stops being a reference to
a file. Deliberately NOT changed: `TASK_PATH_REGEX`, the sibling-name whitelist, the `(new)` artifact
exception, and the two-section scan scope. An ellipsis INSIDE a path segment (`notes…list.md`) stays
flagged — that token still claims to name a file, which is exactly what this checker exists to prove.
*/
const TERMINAL_PUNCTUATION_TAIL = /[`),.;:!?\]}'"\u2026]+$/;

function normalizePathToken(token: string): string {
  return token.replace(/^[`([{"']+/, "").replace(TERMINAL_PUNCTUATION_TAIL, "");
}

function collectTaskPaths(text: string): string[] {
  const matches = text.match(TASK_PATH_REGEX) ?? [];
  return matches.map(normalizePathToken);
}

function collectStepSections(stepsSection: string): Array<{ name: string; body: string }> {
  const sections: Array<{ name: string; body: string }> = [];
  /* FNXC:WorkflowSteps 2026-09-05-22:06: FN-9260 keeps dangling-reference attribution aligned with annotated step headings. */
  const headingMatches = matchStepHeadings(stepsSection);
  for (let i = 0; i < headingMatches.length; i += 1) {
    const heading = headingMatches[i];
    const end = i + 1 < headingMatches.length ? headingMatches[i + 1].index : stepsSection.length;
    sections.push({ name: `Step ${heading.headingNumber}`, body: stepsSection.slice(heading.headingLineEnd, end).trim() });
  }
  return sections;
}

function collectProducedArtifacts(stepsSection: string): Set<string> {
  const produced = new Set<string>();
  for (const step of collectStepSections(stepsSection)) {
    let inArtifacts = false;
    for (const line of step.body.split("\n")) {
      if (line.trim().startsWith("**Artifacts:**")) {
        inArtifacts = true;
        continue;
      }
      if (inArtifacts && /^##|^###/.test(line.trim())) {
        inArtifacts = false;
      }
      if (!inArtifacts) continue;
      if (!line.includes("(new)")) continue;
      for (const token of collectTaskPaths(line)) {
        produced.add(token);
      }
    }
  }
  return produced;
}

function collectFileScopePaths(promptContent: string): Set<string> {
  const section = extractSection(promptContent, "File Scope");
  const paths = new Set<string>();
  for (const token of collectTaskPaths(section)) {
    paths.add(token);
  }
  return paths;
}

function isWhitelistedSiblingArtifact(path: string): boolean {
  return path.endsWith("/PROMPT.md") || path.endsWith("/task.json") || path.includes("/attachments/");
}

function shouldSkipCandidate(path: string, taskId: string, producedArtifacts: Set<string>, fileScopePaths: Set<string>): boolean {
  if (isWhitelistedSiblingArtifact(path)) return true;
  const thisTaskPrefix = `.fusion/tasks/${taskId}/`;
  if (!path.startsWith(thisTaskPrefix)) return false;
  if (producedArtifacts.has(path)) return true;
  if (fileScopePaths.has(path)) return true;
  return false;
}

export async function detectDanglingTaskDocReferences(
  promptContent: string,
  opts: DetectDanglingOptions,
): Promise<DanglingTaskDocReference[]> {
  const existsImpl = opts.existsImpl ?? (async (absPath: string) => {
    try {
      await access(absPath);
      return true;
    } catch {
      return false;
    }
  });

  const contextSection = extractSection(promptContent, "Context to Read First");
  const stepsSection = extractSection(promptContent, "Steps");
  const producedArtifacts = collectProducedArtifacts(stepsSection);
  const fileScopePaths = collectFileScopePaths(promptContent);

  const references = new Map<string, Set<string>>();
  const addReferences = (sectionName: string, text: string) => {
    for (const path of collectTaskPaths(text)) {
      if (shouldSkipCandidate(path, opts.taskId, producedArtifacts, fileScopePaths)) continue;
      const sectionSet = references.get(path) ?? new Set<string>();
      sectionSet.add(sectionName);
      references.set(path, sectionSet);
    }
  };

  addReferences("Context to Read First", contextSection);
  addReferences("Steps", stepsSection);
  for (const step of collectStepSections(stepsSection)) {
    addReferences(step.name, step.body);
  }

  const dangling: DanglingTaskDocReference[] = [];
  for (const [path, sections] of references.entries()) {
    const absPath = join(opts.rootDir, path);
    if (await existsImpl(absPath)) continue;
    dangling.push({ path, sections: Array.from(sections).sort() });
  }

  return dangling.sort((a, b) => a.path.localeCompare(b.path));
}

export function formatDanglingDiagnostic(refs: DanglingTaskDocReference[]): string {
  if (refs.length === 0) return "REVISE — Dangling task-document references in PROMPT.md: none.";
  const lines = ["REVISE — Dangling task-document references in PROMPT.md:"];
  for (const ref of refs) {
    lines.push(`  - ${ref.path} (cited in: ${ref.sections.join(", ")})`);
    lines.push("    Fix: either remove these references, list the file under File Scope as a (new) artifact, or add a step that creates it before it is read.");
  }
  return lines.join("\n");
}
