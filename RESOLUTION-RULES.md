# Conflict resolution rules — merge of origin/main (canonical compact line) into our production line

Context: `origin/main` (theirs, MERGE_HEAD) is upstream's rewritten "feature-reduced" line. HEAD (ours) is our full-featured production line. This merge rebuilds our main on top of canonical. Our line is a SUPERSET: it keeps features upstream deliberately excluded (project notes, whiteboards, human plan/merge approval, task pause accounting, queue order, review-lane ledger, all RUFU/Stash work).

For each conflict hunk (format: <<<<<<< HEAD ours / ||||||| base / ======= theirs / >>>>>>>):

1. Upstream refactor vs our small change to old shape → take THEIRS structure and re-apply our semantic change inside it.
2. Our feature (notes/whiteboards/approval/pause/queue-order/ledger/RUFU-*/Stash) vs upstream removal → KEEP OURS. Never delete a feature this line still runs.
3. Both sides added different independent code at same spot → union (both).
4. Same upstream feature present on both lines in slightly different vintage → prefer THEIRS (canonical) if OURS adds nothing beyond it; keep ours where ours has newer fixes (compare base segment: whichever side diverges from base with substantive logic wins for that logic).
5. Test files: union both sides' cases, EXCEPT cases exercising APIs/features removed from this line (keep ours if our line keeps the feature). Never keep a test calling an identifier that no longer exists in the merged source.
6. Version-number/migration conflicts: canonical owns 0084 (overlap renumber) and 0085 (drop-excluded). Our line does NOT apply canonical 0084/0085; our ledger migration is now 0086. Our released 0074–0083 stay as-is. If a test/const references migration numbers, align to this policy (baseline 0086).
7. Keep code syntactically valid; when in doubt about brace balance, count braces of the surrounding function in both variants.
8. If a side references an identifier the OTHER side's final file content lacks, reconcile (adapt call/import), do not blindly keep dead references.

HARD RULES:
- Do NOT run any git commands. Do not stage/commit/checkout. Only edit the files assigned to you.
- Leave NO conflict markers (<<<<<<<, |||||||, =======, >>>>>>>) in any file you touch.
- When you finish a file, run `grep -c '<<<<<<<' <file>` via your shell tool to double-check it is 0.
- FNXC convention: where you materially decide between vintages, ensure an explanatory FNXC comment exists (add `FNXC:MergeRebuild0919 2026-09-19-21:45:` short note if non-obvious).
- After finishing your whole list, for EACH assigned file append its path as one line to `/home/schindler/git/kb-worktrees/rebuild-main-0919/resolved/<YOUR-GROUP>.txt`, even if you resolved by taking one side wholesale.
