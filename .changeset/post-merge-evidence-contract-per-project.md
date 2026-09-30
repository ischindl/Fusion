---
"@runfusion/fusion": minor
---

summary: A project with no CI reporter no longer needs an operator waiver to finish a landed card.
category: fix
dev: The post-merge gate's evidence requirement is resolved twice over. (1) A project-level fact, `derivePostMergeEvidenceContract()` (`packages/core/src/merge/post-merge-evidence-contract.ts`): a GitHub remote with `.github/workflows` keeps the shard contract unchanged, while OneDev / self-hosted GitLab / Gitea / no-remote projects resolve `not-applicable` — no blocker, no gate re-seed, no waiver; declare it explicitly with project setting `postMergeEvidence` (`{ "provider": "none" | "github-actions" }`); an unreadable project root still fails closed and demands the evidence. (2) The demanded evidence is now authored on the optional-group node — `config.evidence.kind` = `github-actions-full-suite` (absent = today, byte-identical prompt) or `integration-only`, whose prompt asks for landed SHA + landed content instead of CI artifacts, so a board without CI keeps post-merge review instead of dropping the group. A durable negative verdict still blocks, except one recorded before a *derived* observation. `merge:post-merge-evidence-contract` records the decision with provider/source/reason only — never the remote URL. The workflow editor does not expose `evidence.kind` yet (follow-up).
