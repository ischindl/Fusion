---
"@runfusion/fusion": patch
---

Validate File Scope entries in PROMPT.md at task-create/update time. Reject git refs (`origin/fusion/fn-4280`), URLs, SHAs, and other non-path tokens with a clear `InvalidFileScopeError`. `parseFileScopeFromPrompt` also silently drops invalid tokens at read time as defense-in-depth, so the file-scope invariant on squash merges is no longer weakened by malformed scope declarations.
