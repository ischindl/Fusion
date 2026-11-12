import {randomUUID} from "node:crypto";
import {mkdir, readFile, rename, unlink, writeFile} from "node:fs/promises";
import {dirname, join} from "node:path";

/** Byte length of a UTF-8 prompt body — the unit every size decision below is measured in. */
export function promptByteLength(content: string): number {
  return Buffer.byteLength(content, "utf8");
}

/*
FNXC:PromptWriteIntegrity 2026-11-11-22:52 (RUFU-534):
`writePromptFileAtomic` used to land whatever bytes it received and report success, so a payload already
truncated inside the model's own tool-call argument passed its own read-back verification: RUFU-519
accepted a 57 814 B plan and wrote 1 579 B, ending mid-SHA-1, 39.4 s later reported as a success, with no
history kept anywhere to recover from. This hardened form adds two independent, opt-in mechanisms split
apart on purpose so verification can never smuggle in a destructive restore:
- `verifyLanded` (default true) re-reads the file after the rename and byte-compares it to `content`. It is
  a NON-MUTATING check: on a mismatch with compensation off it leaves the file exactly as it is and throws
  `PromptWriteIntegrityError`. The ten best-effort/seed callers keep their present behavior because they
  neither compensate nor change shape.
- `compensateOnMismatch` (default false) is the ONLY thing that may write the previous bytes back, and it
  reads the previous content before the tmp write for exactly that reason. It is fenced: the restore runs
  ONLY while the on-disk bytes are still exactly the bytes this call itself landed. If anything else is on
  disk, a newer legitimate write already replaced them, so it is left untouched and the error names the
  superseded arm. Restoring a byte-older spec over a fresh one is the very destruction class this guards.

The two mechanisms are complementary to the tool's read-back and the shrink guard, not redundant with them:
byte-equality verification cannot see a model-side truncation (received payload equals landed file), which
is why the shrink guard in this file and the row read-back in the prompt-write tool each carry their own
half. The only site that turns compensation on is the authoritative publish in `updateTaskUnlockedImpl`, and
it runs under the planning lifecycle lock, which is where the residual compensation window is closed.
*/
export interface PromptWriteOptions {
  /** Re-read after the rename and byte-compare to `content`. Default true. */
  verifyLanded?: boolean;
  /** On a landed-byte mismatch, restore the previously-read bytes — only under the supersede fence. Default false. */
  compensateOnMismatch?: boolean;
  /** Names the caller in the thrown error so a mismatch is attributable without inspecting content. */
  label?: string;
}

/** Thrown when the bytes that landed on disk are not the bytes a verified authoritative write submitted. */
export class PromptWriteIntegrityError extends Error {
  constructor(readonly details: {
    label: string;
    /** Prior file bytes when compensation read them, else null (never read to keep an unverified path read-free). */
    priorBytes: number | null;
    landedBytes: number;
    expectedBytes: number;
    /** True when a newer write replaced the bytes before the fenced restore could run. */
    superseded: boolean;
    /** On-disk bytes observed at the compensating re-read, present only on the superseded arm. */
    supersededBytes: number | null;
  }) {
    const { label, priorBytes, landedBytes, expectedBytes, superseded, supersededBytes } = details;
    const priorText = priorBytes === null ? "unread prior" : `${priorBytes} B`;
    const tail = superseded
      ? `A newer write (${supersededBytes} B) superseded the bytes before compensation could run, so nothing was restored.`
      : "The file was left exactly as it landed and was not restored.";
    super(`PROMPT_WRITE_INTEGRITY: ${label} landed ${landedBytes} B but ${expectedBytes} B was submitted (prior ${priorText}). ${tail}`);
    this.name = "PromptWriteIntegrityError";
  }
}

/** Duck-typed guard so the classification survives a mocked `@fusion/core` (mirrors `isDuplicatedPromptSectionError`). */
export function isPromptWriteIntegrityError(value: unknown): value is PromptWriteIntegrityError {
  return value instanceof PromptWriteIntegrityError;
}

/*
FNXC:PromptWriteIntegrity 2026-11-11-22:52 (RUFU-534):
The material-shrink guard. Landed-byte verification cannot catch RUFU-519's loss: there the received
payload equaled the landed file (the model truncated its own tool-call argument), so byte-equality
verification saw a zero diff and reported success. The only signal at the write boundary is a comparison
against the bytes already on disk. The guard refuses an authoritative replacement that would materially
shrink an accepted spec BEFORE anything is committed, leaving both the row and the file untouched so the
previous version stays the recovery source.

The two bounds are deliberately conservative so legitimate editing keeps working: a spec below
`PROMPT_SHRINK_MIN_PRIOR_BYTES` is never guarded (an author may legitimately keep a short spec short), and
the ratio of 0.5 means only a loss of more than half the prior bytes is refused. A person who deliberately
shortens a plan keeps that power through an explicit `allowShrink` authorization, which is carried at the
one route that delivers human intent; AI prompt-write lanes are never authorized.
*/
export const PROMPT_SHRINK_MIN_PRIOR_BYTES = 4096;
export const PROMPT_SHRINK_MIN_RATIO = 0.5;

/** True only when a prior spec at/above the floor would fall below half its size. */
export function isMaterialPromptShrink(priorBytes: number, nextBytes: number): boolean {
  return priorBytes >= PROMPT_SHRINK_MIN_PRIOR_BYTES && nextBytes < Math.floor(priorBytes * PROMPT_SHRINK_MIN_RATIO);
}

/** Refusal carrying both byte counts plus an optional pointer at the largest durable copy, never the content. */
export class PromptShrinkRejectedError extends Error {
  constructor(readonly details: { label: string; priorBytes: number; nextBytes: number; recovery: string | null }) {
    const { label, priorBytes, nextBytes, recovery } = details;
    const recoveryText = recovery
      ? ` Recover from ${recovery}.`
      : " If a durable prior revision exists it is stored under the task's plan document.";
    super(
      `PROMPT_SHRINK_REJECTED: ${label} would replace a ${priorBytes} B PROMPT.md with ${nextBytes} B, below the ${PROMPT_SHRINK_MIN_RATIO} ratio of a spec at or above the ${PROMPT_SHRINK_MIN_PRIOR_BYTES} B floor.` +
        `${recoveryText} Re-issue the complete specification; an intentional slim replacement must be explicitly authorized.`,
    );
    this.name = "PromptShrinkRejectedError";
  }
}

/** Duck-typed guard so the classification survives a mocked `@fusion/core` (mirrors `isDuplicatedPromptSectionError`). */
export function isPromptShrinkRejectedError(value: unknown): value is PromptShrinkRejectedError {
  return value instanceof PromptShrinkRejectedError;
}

/** The largest byte length among stored copies — the recovery target is the biggest one, not the newest. */
export function largestPriorPromptBytes(contents: readonly (string | null | undefined)[]): number {
  let largest = 0;
  for (const content of contents) {
    const bytes = content ? promptByteLength(content) : 0;
    if (bytes > largest) largest = bytes;
  }
  return largest;
}

/**
 * Refuse an authoritative prompt replacement that would materially shrink the file already on disk, unless
 * the caller passes an explicit `allowShrink` (only for a proven deliberate wholesale replacement). With no
 * prior file there is nothing to shrink. The optional `recovery` names the largest durable copy; only the
 * tool layer can read the mirror chain, so the store seam passes none and the tool adds it in its refusal.
 */
export async function assertNoAuthoritativePromptShrink(args: {
  promptPath: string;
  nextContent: string;
  allowShrink: boolean;
  label: string;
  recovery?: string | null;
}): Promise<void> {
  if (args.allowShrink) return;
  const prior = await readIfPresent(args.promptPath);
  if (prior === null) return;
  const priorBytes = promptByteLength(prior);
  const nextBytes = promptByteLength(args.nextContent);
  if (!isMaterialPromptShrink(priorBytes, nextBytes)) return;
  throw new PromptShrinkRejectedError({ label: args.label, priorBytes, nextBytes, recovery: args.recovery ?? null });
}

/** Read a file's UTF-8 body, returning null when it is absent or unreadable. */
async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * The original same-directory tmp + rename publish. Kept as the single atomic writer so the fenced
 * compensation restore is itself atomic and never re-verifies or re-compensates.
 */
async function atomicRenameWrite(promptPath: string, content: string): Promise<void> {
  const parentDir = dirname(promptPath);
  const tmpPath = join(parentDir, `PROMPT.md.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(parentDir, { recursive: true });
  await writeFile(tmpPath, content);
  try {
    await rename(tmpPath, promptPath);
  } catch (error) {
    try {
      await unlink(tmpPath);
    } catch {
      // The temporary file may already be absent; preserve the rename failure.
    }
    throw error;
  }
}

/*
FNXC:TaskDetailPlan 2026-08-28-15:31:
A truncating PROMPT.md write lets getTask, the narrow prompt route, and step parsing observe an empty or
prefix-truncated plan. Publish through a same-directory unique temporary file so the Definition summary
never disappears because a reader raced plan publication.

FNXC:PromptWriteIntegrity 2026-11-11-22:52 (RUFU-534):
The rename is now verified (see the block above `PromptWriteOptions`). A verified mismatch that a caller
asked to compensate is restored only under the supersede fence, never unconditionally.
*/
export async function writePromptFileAtomic(promptPath: string, content: string, options: PromptWriteOptions = {}): Promise<void> {
  const verifyLanded = options.verifyLanded ?? true;
  const compensateOnMismatch = options.compensateOnMismatch ?? false;
  const label = options.label ?? "PROMPT.md";

  // Read the previous bytes ONLY when compensation may need them; an unverified/uncompensated write reads nothing extra.
  const priorContent: string | null | undefined = compensateOnMismatch ? await readIfPresent(promptPath) : undefined;

  await atomicRenameWrite(promptPath, content);

  if (!verifyLanded) return;

  const landed = await readIfPresent(promptPath);
  const landedBytes = landed === null ? 0 : promptByteLength(landed);
  const expectedBytes = promptByteLength(content);
  if (landed === content) return;

  const priorBytes = priorContent === undefined || priorContent === null ? null : promptByteLength(priorContent);

  // Compensation off: this is the whole contract for the best-effort and seed callers — leave the file untouched.
  if (!compensateOnMismatch) {
    throw new PromptWriteIntegrityError({ label, priorBytes, landedBytes, expectedBytes, superseded: false, supersededBytes: null });
  }

  // Compensation on, but fenced: re-read and restore ONLY while the on-disk bytes are still the bytes this call landed.
  const nowOnDisk = await readIfPresent(promptPath);
  if (nowOnDisk !== landed) {
    // A newer legitimate write already replaced our bytes; leave it untouched.
    const supersededBytes = nowOnDisk === null ? 0 : promptByteLength(nowOnDisk);
    throw new PromptWriteIntegrityError({ label, priorBytes, landedBytes, expectedBytes, superseded: true, supersededBytes });
  }

  // Compensation is on here, which is exactly the branch that read the prior bytes, so `undefined` is unreachable.
  const priorForRestore: string | null = priorContent ?? null;
  if (priorForRestore === null) {
    // No prior file existed; remove the bad file so the reader sees "absent" rather than truncated content.
    try {
      await unlink(promptPath);
    } catch {
      // Already absent; the caller learns of the failure from the thrown error regardless.
    }
  } else {
    await atomicRenameWrite(promptPath, priorForRestore);
  }
  throw new PromptWriteIntegrityError({ label, priorBytes, landedBytes, expectedBytes, superseded: false, supersededBytes: null });
}
