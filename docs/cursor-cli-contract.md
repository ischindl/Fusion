# Cursor CLI Contract (FN-3396 Step 0)

Date: 2026-05-07

## Research method

- Local runtime inspection in the task environment (`which`, direct command execution).
- Local binary wrapper inspection (`cursor`, `cursor-agent` launch scripts and install layout).
- Bounded `fn_research_run` was attempted but failed in this environment with: `table research_runs has no column named projectId`.

## Confirmed invocation and binary detection

- **Primary executable aliases found on PATH:**
  - `cursor`
  - `cursor-agent`
- **Not found on PATH:**
  - `cursor-cli`
- `cursor` is a wrapper that can delegate to agent mode and emits a targeted message when IDE install is missing.
- `cursor-agent` is the direct CLI runtime entrypoint and is symlinked to a versioned install under:
  - `~/.local/share/cursor-agent/versions/<version>/cursor-agent`

### Detection strategy

1. If the global `cursorCliBinaryPath` setting is a non-empty string, probe that configured binary first.
2. Probe `cursor-agent` from PATH.
3. Probe `cursor` from PATH.
4. Deduplicate candidates when the configured value is exactly `cursor-agent` or `cursor`.
5. Persist the resolved path and executable name in probe results.
6. Report explicit failure reason when neither exists.

### Manual binary path override

<!--
FNXC:CursorCli 2026-07-02-00:00:
Operators can set a global Cursor CLI binary path when PATH discovery resolves the wrong shim. The override is optional and must never remove the cursor-agent/cursor fallback probes.
-->

Settings → Authentication → Cursor CLI exposes an optional binary path field. Leave it blank to use PATH auto-detection. When populated, Fusion validates the configured path by running the same `--version` probe used for status/enable, saves it only if that configured candidate itself succeeds, and then uses it for status, enable validation, and Cursor model discovery before falling back to PATH candidates.

If the configured path fails during ordinary status/model-discovery probes but a PATH candidate succeeds, Fusion remains usable and reports the PATH candidate as the effective `binaryPath`; bounded diagnostics include the configured-path failure. If saving a new non-empty override fails or only succeeds via PATH fallback, the Settings save returns a 400 diagnostic and does not persist the path.

Windows paths with spaces, for example `C:\Users\A User\AppData\Roaming\npm\cursor-agent.cmd`, are treated as one operator-provided string. Users should not quote or split the path in the UI.

### Windows PATH shim invocation

<!--
FNXC:CursorCli 2026-07-02-00:00:
Windows Cursor installs may publish `cursor-agent.cmd`, `cursor.cmd`, or equivalent `.bat` shims on PATH; Fusion must invoke Cursor probe and discovery commands through the Windows shell so Node can execute those wrappers.
Unix and macOS stay direct-spawned to avoid broadening shell semantics beyond the platform that requires it.
-->

On Windows, `cursor-agent`, `cursor`, and manual override paths can resolve to `.cmd` / `.bat` wrappers rather than native executables. Node.js direct `spawn(binary, args)` does not execute those wrappers reliably; Fusion's Cursor command runner therefore sets shell execution only when `process.platform === "win32"`.

The Windows shell-backed path applies to every Cursor CLI command Fusion currently runs through the shared runner:

- Configured binary / `cursor-agent --version` / `cursor --version` probe attempts.
- Model discovery attempts against the effective probe-selected binary: `models --json`, `model list --json`, and `models`.

Non-Windows probes and discovery continue to use direct spawn. Spawn errors such as `ENOENT` or `EACCES` are included in the unavailable probe reason in bounded diagnostic form so a working terminal command is distinguishable from known Cursor runtime/auth states; Fusion does not dump PATH, environment variables, or unbounded stdout/stderr.

## Confirmed error/auth/runtime signals

Observed command behavior in this environment:

- `cursor --help` (without IDE install):
  - `Error: No Cursor IDE installation found. Use 'cursor agent' or 'agent' to run the agent.`
- `cursor-agent --help` and `cursor agent --help` (with locked keychain):
  - `Error: Your macOS login keychain is locked.`
  - `Run security unlock-keychain and try again.`

### Auth/readiness implications

- Keychain-locked is a distinct, expected failure mode and must be surfaced as an auth/runtime-blocked state (not as unknown crash).
- Missing IDE install is a distinct expected failure mode from missing binary.

## Structured output and model discovery

- **No stable model-list command was conclusively confirmed in this preflight** due CLI gating by keychain lock and inability to complete bounded remote research in this run.
- No contract evidence yet for a guaranteed `--json` or dedicated model enumeration command.

### Fallback model discovery strategy (to use in implementation)

1. Attempt known structured/listing command variants with short timeouts (plugin-defined sequence).
2. If structured output is unavailable but text output exists, parse tolerant line-based IDs.
3. Normalize and dedupe model IDs.
4. If discovery is unavailable/fails, return an empty discovered set with:
   - `source` marking probe mode,
   - `fallbackUsed: true`,
   - machine-readable reason.
5. Host should only surface Cursor models when provider readiness + discovery usability conditions are met.

## Provider ID decision

- Use **`cursor-cli`** as the provider ID.
- Rationale: aligns with task requirement; no conflicting provider ID observed in current codebase scan.

## Contract freeze for FN-3396

Implementation should treat the following as canonical for this task unless stronger evidence is found during code-level integration tests:

- Binary candidates: `cursor-agent`, `cursor`.
- Expected failure states include: missing binary, missing IDE installation, keychain locked, unauthenticated/not-ready CLI.
- Model discovery must be dynamic-first with resilient fallback and no hardcoded static catalog by default.
