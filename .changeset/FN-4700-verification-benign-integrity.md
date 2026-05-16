---
"@runfusion/fusion": patch
---

Suppress false `missing-evidence` warnings on verification-only / no-code follow-up tasks by classifying branch-absent no-owned-commit finalizes as benign `no-changes-finalized` and clearing stale `modifiedFiles` snapshots.
