---
"@runfusion/fusion": patch
---

summary: Git installed while Fusion is running is now detected without a restart — project setup no longer fails with spawn git ENOENT.
category: fix
dev: "New core git-binary resolver: on PATH ENOENT, probes well-known install locations (win32 Program Files/LocalAppData Git\\cmd, macOS homebrew//usr/local//usr/bin, linux /usr/bin//usr/local/bin) with caching + invalidation on later ENOENT. Wired into ensureGitRepositoryForProjectPath's runner, probeGitCliStatus (onboarding git indicator), and the dashboard clone route."
