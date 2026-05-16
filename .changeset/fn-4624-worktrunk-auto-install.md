---
"@runfusion/fusion": minor
---

Auto-install flow for the optional worktrunk worktree backend: when `worktrunk.enabled` is on and the binary is missing, Fusion downloads a SHA-256-verified pinned release (v0.4.2) into `~/.fusion/bin/` with a `cargo install` fallback under `network_api` approval policy. Pinned release supports `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`; Windows falls back to cargo-only. Install attempts emit run-audit `binary:install-*` events.
