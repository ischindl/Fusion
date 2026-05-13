---
"@runfusion/fusion": patch
---

Fix executor baseCommitSha capture to use the merge-base with main instead of HEAD,
and preserve an existing valid baseCommitSha across multi-session task work.
Resolves false `fn_task_done` "no_commits — observed=0" failures on multi-session
branches (FN-4309).
