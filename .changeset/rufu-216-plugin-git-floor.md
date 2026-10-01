---
"@runfusion/fusion": patch
---

summary: Autonomous cards on the droid, Paperclip, and OpenClaw runtimes can no longer hang on interactive git prompts.
category: fix
dev: RUFU-210's applyNonInteractiveGitEnv floor now wraps the session/prompt spawns in those three runtime plugins (droid spawnDroid, paperclip runPaperclipJson/streamPaperclipRun, openclaw promptCli); each package gained the @fusion/core workspace dep and the CLI staged-plugin shim re-exports the helper so bundled builds keep the floor. Probe and MCP-config/key-mint seams stay operator-driven by design.
