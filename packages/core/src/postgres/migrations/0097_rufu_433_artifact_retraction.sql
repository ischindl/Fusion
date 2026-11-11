/*
FNXC:ArtifactRetraction 2026-11-11-11:55 (RUFU-433):
Adds the tombstone columns that give the artifact registry a non-destructive way out.

The incident this exists for: a reviewer registered a false review artifact against the wrong card and
the wrong head, then found there was no way to remove it. The tool surface (`fn_artifact_list` /
`fn_artifact_register` / `fn_artifact_view`) adds and reads only; there is no delete and no
invalidation. The only remedy an agent held was to publish a SECOND artifact disclaiming the first,
which thickens exactly the layer the false evidence sits in. Physical removal was left to the operator
by hand in the database. That asymmetry is a product defect for any error shape — mis-attached to a
foreign card, stale after remediation, duplicated, or carrying sensitive data — not just for fabrication.

Three nullable `text` columns, matching this table's existing `text` timestamp convention:
  retracted_at    when the retraction happened (NULL = never retracted)
  retracted_by    who retracted it (author id for an agent, session user for the operator)
  retract_reason  the mandatory-at-the-surface sentence explaining the retraction

Additive only, no backfill, no drop, and `0000_initial.sql` stays untouched — the RUFU-299/0095
precedent: declare the column, ship a forward migration, leave the baseline alone. A row written before
this migration reports "never retracted", which is the truth for it, so every pre-existing artifact
behaves as valid by absence and nothing about an upgrade can change a past verdict.

Why a tombstone instead of a DELETE: an artifact can be the backdrop of a review or of merge evidence,
so a silent hard delete would destroy the record that a claim was ever made. The VOID rendering and the
default-hiding on every read surface remove the false content from circulation; these columns keep the
trail. `retract_reason` is mandatory at the write surface but nullable here because the column has to
accept the rows it cannot retroactively explain.

No index: `retracted_at` is never a standalone predicate. The read paths filter it as an extra qualifier
on a selection they already made by project (list) or by primary key (view), so an index would be write
cost with no reader.
*/

ALTER TABLE project.artifacts ADD COLUMN IF NOT EXISTS retracted_at text;
ALTER TABLE project.artifacts ADD COLUMN IF NOT EXISTS retracted_by text;
ALTER TABLE project.artifacts ADD COLUMN IF NOT EXISTS retract_reason text;
