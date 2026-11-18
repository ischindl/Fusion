---
"@runfusion/fusion": minor
---

summary: Plans that declare an absence over a file their own steps will write are refused deterministically at Plan Review.
category: feature
dev: The Plan Review node runs a deterministic shape gate over `## Plan Premises` — a `file-absent`/`text-absent` premise whose path is inside the same plan's write scope (File Scope entries, `(new)` artifact lines and step-embedded scope blocks, with separators canonicalized the way `spec-lock.ts` does) is self-consuming: execution is what falsifies it. The refusal costs no reviewer session and no unit of the review-revision budget, because the plan-replan loop can act on a deterministic verdict, and it is advisory-toward-overrefusal: an unreadable premises block yields no findings, `text-present`/`file-exists` premises are never refused deterministically, and every classifier exclusion in `extractEffectiveWriteScopeFromPrompt` (read-only context, fusion metadata, generated lockfiles, conditional changesets) stays authoritative. Planning, Plan Review and fast-planning policy copy plus the PROMPT.md template now state the rule, including the sibling shape no gate can decide — a `text-present` literal quoted from source the plan's own steps rewrite.
