/**
 * File Scope parsing and validation helpers.
 *
 * FNXC:TaskStoreDecompose 2026-06-24-00:00:
 * Extracted from the monolithic packages/core/src/store.ts (U5 decomposition).
 * Pure behavior-invariant move: function bodies are byte-identical to their
 * pre-extraction form. store.ts re-imports these helpers.
 *
 * FNXC:FileScopeClassification 2026-07-21-12:00:
 * isValidFileScopeEntry is owned by file-scope-classification.ts so create/update
 * validation and extractEffectiveWriteScopeFromPrompt cannot drift. Root-level
 * files with extensions (global.json, Directory.Packages.props, MyApp.slnx) must
 * pass both paths — GitHub issue bodies that declare them were failing import.
 *
 * FNXC:FileScopeClassification 2026-07-21-18:05:
 * Token extraction and section location are shared with classification so fenced
 * code-block File Scope headings (issue repros) are ignored consistently on create,
 * sanitize, and effective write-scope paths.
 *
 * FNXC:FileScopeClassification 2026-11-11-16:08 (RUFU-494):
 * Sanitize now consumes the SAME leading-candidate line walk the validator uses. Its old inline
 * per-line `/`([^`]+)`/g` + `tokens.every(...)` filter treated an annotation span as a declared path,
 * so it DELETED the whole annotated bullet from the copied spec - refineTask, duplicateTask, and
 * archive restore could silently drop the very file the follow-up card was about to edit. A line
 * whose leading candidate is valid is now kept byte-for-byte, annotation and all.
 */
export { isValidFileScopeEntry, extractFileScopeTokens } from "../tasks/file-scope-classification.js";
import {
  isValidFileScopeEntry,
  extractFileScopeTokens,
  iterateFileScopeSectionLines,
  locateFileScopeSection,
} from "../tasks/file-scope-classification.js";

/**
 * Split an operator-declared `## File Scope` into declared entries and refusals.
 *
 * FNXC:FileScopeClassification 2026-11-11-16:08 (RUFU-494):
 * `invalid` holds ONLY leading candidates that `isValidFileScopeEntry` refuses (`origin/main`, a bare
 * `rerouted`, an escaping path) - never an inline annotation. That list is what all three
 * `InvalidFileScopeError` throw sites report, so a spec written in the repo's encouraged annotated
 * style reaches PROMPT.md instead of burning a planning pass.
 */
export function validateFileScopeInPromptContent(prompt: string): { valid: string[]; invalid: string[] } {
  const tokens = extractFileScopeTokens(prompt);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const token of tokens) {
    if (isValidFileScopeEntry(token)) {
      valid.push(token);
    } else {
      invalid.push(token);
    }
  }
  return { valid, invalid };
}

/**
 * Rebuild a prompt whose File Scope declares at least one refused path, dropping ONLY the lines
 * whose leading candidate is refused.
 *
 * FNXC:FileScopeClassification 2026-11-11-16:08 (RUFU-494):
 * Line-granular and leading-candidate only, through the classifier's shared walk: no candidate
 * means prose or context (kept), a valid candidate keeps the WHOLE line including its annotation,
 * and an invalid candidate drops just that line and reports just that candidate. The previous filter
 * asked whether EVERY backtick span on the line was a valid path, so an annotated but perfectly
 * valid bullet was deleted outright from every refine/duplicate/archive-restore copy.
 */
export function sanitizeFileScopeInPromptContent(prompt: string): { sanitized: string; dropped: string[]; kept: string[] } {
  const located = locateFileScopeSection(prompt);
  if (!located) {
    return { sanitized: prompt, dropped: [], kept: [] };
  }

  const { sectionStart, sectionEnd } = located;
  const section = prompt.slice(sectionStart, sectionEnd);
  const { valid: kept, invalid: dropped } = validateFileScopeInPromptContent(prompt);
  if (dropped.length === 0) {
    return { sanitized: prompt, dropped, kept };
  }

  const sanitizedSection = Array.from(iterateFileScopeSectionLines(section))
    .filter(({ candidate }) => candidate === null || isValidFileScopeEntry(candidate))
    .map(({ line }) => line)
    .join("\n");

  return {
    sanitized: `${prompt.slice(0, sectionStart)}${sanitizedSection}${prompt.slice(sectionEnd)}`,
    dropped,
    kept,
  };
}
