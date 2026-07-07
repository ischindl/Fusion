---
"@runfusion/fusion": patch
---

summary: Fix onboarding GitHub sign-in button erroring instead of starting GitHub auth.
category: fix
dev: The onboarding/settings GitHub step no longer offers dashboard-managed OAuth login when no `github` OAuth provider is registered (pi ships only anthropic/github-copilot/openai-codex); it now presents gh CLI (`gh auth login`) guidance. `/api/auth/login` returns a clear unknown-provider error for `github` instead of a misleading "model not found".
