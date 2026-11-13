/*
FNXC:EpisodeRegisterStorage 2026-11-13-23:04 (RUFU-1027):
Fake stores in this family applied an `updateTask` patch with a bare spread. That is wrong for one
field and the wrongness is load-bearing: `sourceMetadataPatch` is a KEY-level write that the real
store merges INTO `sourceMetadata` (`packages/core/src/task-store/task-update.ts`), so a spread stores
a literal `sourceMetadataPatch` property, the row never gains the episode key, and any reader of
`sourceMetadata[...]` sees nothing. A recovery ladder that persists its counter there then looks broken
in the loudest possible way — every test in the file fails, including ones about unrelated branches —
while the production code is fine. One shared applier, so the semantics live in one place instead of
being re-guessed per file.
*/

/** Applies a `TaskStore.updateTask`/`updateTaskAtomic` patch the way the store does. */
export function applyTaskPatch<T extends Record<string, any>>(row: T, patch: Record<string, unknown>): T {
  const { sourceMetadataPatch, ...rest } = patch as Record<string, unknown> & {
    sourceMetadataPatch?: Record<string, unknown> | null;
  };
  const next = { ...row, ...rest } as T;
  if (sourceMetadataPatch === null) {
    next.sourceMetadata = undefined;
  } else if (sourceMetadataPatch !== undefined) {
    next.sourceMetadata = { ...((row.sourceMetadata as object) ?? {}), ...sourceMetadataPatch };
  }
  return next;
}
