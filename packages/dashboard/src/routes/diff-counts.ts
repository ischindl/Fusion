export interface DiffLineCounts {
  additions: number;
  deletions: number;
}

export function countPatchLines(patch: string): { additions: number; deletions: number } {
  if (!patch) {
    return { additions: 0, deletions: 0 };
  }

  let additions = 0;
  let deletions = 0;

  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++ ")) {
      additions += 1;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("--- ")) {
      deletions += 1;
    }
  }

  return { additions, deletions };
}

/*
FNXC:TaskDiffStats 2026-09-10-04:03:
Parses the stdout of `git diff --numstat -z` into a per-path lookup table so the /tasks/:id/diff
stats-only lane answers the card badge with ONE whole-tree stat subprocess instead of the per-file
`git diff <rev> -- <path>` fan-out (measured 2026-09-09: at the dashboard's ~2 GB live RSS one
subprocess spawn costs 25-40 ms of main-thread CPU, so an N-file card paid N+ spawns for one integer).

Record layout with `-z` (measured on git 2.55.0):
- ordinary record: `<added>\t<deleted>\t<path>\0` — the path may contain spaces/unicode verbatim.
- rename/copy record: `<added>\t<deleted>\0<pre-image>\0<post-image>\0` — keyed here on the post-image
  (destination), because the `-M` `--name-status` path set that this table is joined onto is keyed on
  the destination too.
- binary record: counts are `-`; they map to 0/0, matching what `countPatchLines` yields for the
  binary patch body today (no `+`/`-` content lines). Never `NaN`.

The `/diff` stats lane MUST pass `--no-renames`. `diff.renames` defaults to true, so a rename-detected
numstat reports a pure rename as `0 0` while today's pathspec-limited per-file patch (`git diff <rev> --
<path>`, which cannot pair a source outside its single-path pathspec) reports it as a full add. Joining
a rename-detected table would therefore silently shrink the operator's number; per-path parity with
`countPatchLines` is the arbiter. A rename-shaped record is still parsed (so a caller that omits the
flag gets the destination key rather than a malformed-path gap), but only `--no-renames` is parity-safe.
*/
export function parseNumstatOutput(raw: string): Map<string, DiffLineCounts> {
  const counts = new Map<string, DiffLineCounts>();
  if (!raw) return counts;

  const fields = raw.split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;

    const segments = field.split("\t");
    if (segments.length >= 3) {
      const path = segments.slice(2).join("\t");
      if (path) counts.set(path, numstatCounts(segments[0]!, segments[1]!));
      continue;
    }

    if (segments.length === 2) {
      // Rename/copy record: the two following NUL fields are the pre- and post-image paths.
      const sourcePath = fields[index + 1] ?? "";
      const destinationPath = fields[index + 2] ?? "";
      index += 2;
      const path = destinationPath || sourcePath;
      if (path) counts.set(path, numstatCounts(segments[0]!, segments[1]!));
    }
  }

  return counts;
}

function numstatCounts(added: string, deleted: string): DiffLineCounts {
  return { additions: parseNumstatCount(added), deletions: parseNumstatCount(deleted) };
}

/** numstat emits `-` for binary paths; anything unparsable stays 0 so a malformed row never poisons the total. */
function parseNumstatCount(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
