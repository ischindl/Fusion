---
"@runfusion/fusion": patch
---

Migrate the six remaining built-in prompt-mode workflow step templates (documentation-review, qa-check, security-audit, performance-review, accessibility-check, browser-verification) to emit the structured {verdict, notes} JSON contract introduced in FN-4367. Fix the frontend-ux-design template's verdict enum to match the parser's accepted set (APPROVE | APPROVE_WITH_NOTES | REVISE). Ships scripts/replace-seeded-workflow-prompts.mjs as a one-off operator tool to bring already-materialized project DB rows (e.g. WS-004) onto the new prompts; the prose-fallback path remains intact for backward compatibility.
