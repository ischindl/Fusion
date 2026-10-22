/**
 * FNXC:ReviewInputTypeSafety 2026-10-22-13:02 (RUFU-771):
 * Several dispatch paths call `.trim()` on elements of an array that was read out of persisted JSON
 * (workflow-step metadata, task repository scope). TypeScript types those arrays as `string[]`, but the
 * values arrive from a database row or a task JSON mirror, so one `null`/`undefined` element makes the
 * lane die with `Cannot read properties of undefined (reading 'trim')` — a TypeError with no named cause,
 * thrown BEFORE any reviewer exists and before a review-input fingerprint is computed. That ordering is
 * what makes the crash invisible afterwards: the persisted step row carries no `reviewInputFingerprint`
 * at all, which is exactly the discriminator reported from rtm3 (10 of 10 crashed rows lacked it, 0 of
 * 117 completed rows did).
 *
 * The sibling custom-node path already guarded this shape by filtering `typeof name === "string"` before
 * trimming (`run-graph-custom-node.ts:949`); this module gives the built-in review path the same input
 * discipline, and it returns a REJECTED COUNT rather than silently dropping entries. Silent dropping is
 * not acceptable here: a read-only MCP allowlist or a declared repository scope that quietly shrinks is a
 * fail-closed change nobody can observe, and the reported fix constraint is explicit — a fix that only
 * makes the throw disappear would mint approvals over empty review input at scale, so undefined input
 * must be refused and named.
 */
export type TrimmedStringListParse = {
  /** Non-empty trimmed strings, in input order. */
  items: string[];
  /** Elements that were present but not a string. Non-zero means the persisted JSON is malformed. */
  rejectedCount: number;
};

/** Parse an unknown value as a list of trimmed strings, counting elements that are not strings. */
export function parseTrimmedStringList(value: unknown): TrimmedStringListParse {
  if (!Array.isArray(value)) return { items: [], rejectedCount: 0 };
  const items: string[] = [];
  let rejectedCount = 0;
  for (const element of value) {
    if (typeof element !== "string") {
      rejectedCount += 1;
      continue;
    }
    const trimmed = element.trim();
    if (trimmed) items.push(trimmed);
  }
  return { items, rejectedCount };
}

export type ReadonlyMcpAllowlistDecision = {
  /** The allowlist to hand the reviewer, empty when the step is being refused. */
  allowlist: string[];
  /** Number of non-string elements that made the persisted metadata malformed. */
  rejectedCount: number;
  /** Set when the metadata is malformed: the step must refuse rather than run on a shrunk allowlist. */
  diagnostic?: string;
};

/**
 * Decide the read-only MCP allowlist for one review step. A malformed entry refuses the step: the
 * alternative is running a read-only reviewer with an allowlist that silently lost servers, which
 * changes what the reviewer could reach without any record that it happened.
 */
export function evaluateReadonlyMcpAllowlist(
  metadataValue: unknown,
  enabled: boolean,
): ReadonlyMcpAllowlistDecision {
  if (!enabled) return { allowlist: [], rejectedCount: 0 };
  const parsed = parseTrimmedStringList(metadataValue);
  if (parsed.rejectedCount === 0) return { allowlist: parsed.items, rejectedCount: 0 };
  return {
    allowlist: [],
    rejectedCount: parsed.rejectedCount,
    diagnostic:
      `workflow-step metadata field readonlyMcpServers carries ${parsed.rejectedCount} `
      + "element(s) that are not strings; the read-only reviewer cannot run on an allowlist "
      + "that lost entries, so the step is refused until the metadata is repaired",
  };
}
