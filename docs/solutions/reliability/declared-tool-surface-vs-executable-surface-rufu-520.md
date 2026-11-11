---
title: "The tools the model may name are not the tools the run may execute, so a call lands on a lookalike handler"
date: 2026-11-11
category: reliability
problem_type: reliability
module: "@fusion/pi-claude-cli, @fusion/droid-cli, @fusion-plugin-examples/droid-runtime"
component: CLI bridge tool declaration and dispatch
tags:
  - tool-dispatch
  - mcp
  - cli-bridge
  - claude-cli
  - droid-cli
  - prompt-schema-skew
symptoms:
  - "an fn_* coordination call comes back as the output of a built-in coding tool"
  - "a read result reports a file that does not exist, under a path shaped like the tool name"
  - "the transcript shows a fabricated read of /fusion/<tool-name>, /<tool-name>, or ./<tool-name>"
  - "a tool call the session never activated still appears in the model's tool list"
  - "an MCP config file written earlier in the run keeps being reused after the session's tool set changed"
affected:
  - "packages/pi-claude-cli/index.ts"
  - "packages/pi-claude-cli/src/tool-surface.ts"
  - "packages/pi-claude-cli/src/event-bridge.ts"
  - "packages/pi-claude-cli/src/acp-driver.ts"
  - "packages/pi-claude-cli/src/mcp-schema-server.cjs"
  - "packages/droid-cli/index.ts"
  - "plugins/fusion-plugin-droid-runtime/src/tool-surface.ts"
  - "plugins/fusion-plugin-droid-runtime/src/event-bridge.ts"
---

# Declared tool surface vs executable tool surface (RUFU-520)

## The bug in one line

Both CLI bridges told the model it could call tools the session had not made executable, and offered
no refusal path, so a refused call was answered by whatever handler happened to accept the fabricated
path the model fell back to.

## Observed symptom

A `fn_task_show` request in a `claude-cli`-lane session returned the output of the built-in `read`
tool: `File not found: /fusion/fn_task_show`. Nothing was cross-wired inside pi. The model had asked
for a tool that was in its declared list but not executable in that run, received a failure it could
not read as a failure, and improvised a path-argument call to the nearest tool that would accept one.

## What the card's premise got wrong

The spec claimed pi dispatches tool calls "positionally, or from the last-used handler". That is
false at the pinned version and was disproved by reading pi's own source rather than inferred from the
symptom. `prepareToolCall` in
`@earendil-works/pi-coding-agent/dist/bundle/chunks/chunk-OIM2DMFI.js` resolves the handler by exact
requested name:

```js
let tool = tools.find(t => t.name === toolCall.name);
if (!tool) return { kind: "immediate", result: createErrorToolResult("Tool " + toolCall.name + " not found"), isError: !0 }
```

So pi already refuses an undeclared name, and an engine-side wrapper guard would guard a defect that
does not exist. The card's second premise was also wrong: `getCurrentTools()` replay cannot lag the
active set in the way described, because `getToolStateChanges()` diffs previous against current and
emits a removal for every dropped definition on each new system message.

## The actual root cause, in order of weight

1. **Prior-state returns.** Four branches of `ensureMcpConfig()` (two per bridge lane) answered a
   derivation failure with `cachedMcpConfig?.configPath`: an empty derived tool list, an unreadable
   `pi.getAllTools()`, a missing `customTools` entry, and a config-file write failure. Any of them
   handed the CLI a tool list from a previous call for the rest of the run, because the hash-keyed
   cache made a drifted derivation sticky.
2. **Membership taken from transcript replay.** `cliContext.tools` and the MCP config were populated
   from `getCurrentTools(context.messages)`. Replay carries the *declaration text* the session
   published, which is what the prompt needs, but it is not an answer to "which tools may this run
   execute". A tool revoked mid-session stayed declared, and a tool that was active but never named by
   an earlier system message was missing from the schema while the prompt adapters still listed it.
3. **Silence as the only refusal.** The bridge event loop skipped a name pi did not recognise by
   emitting `tool_start` and dropping it. No result reached the model, and the schema-only MCP server
   answered `tools/call` with `null`, which hangs a CLI rather than informing it.
4. **Registry-wide fallback.** `getCustomToolDefs(pi)` declared every registered custom tool with no
   reference to the active set, and fired whenever the transcript happened to carry no tools.

## The invariant

- The declared tool surface is `pi.getActiveTools()` intersected with the `pi.getAllTools()` registry,
  minus pi built-ins, minus the exposures pi cannot declare (`codemode`, `deferred`, `hidden`).
  Replay supplies declaration text only. This is the only formulation that holds when tools are
  revoked *and* when they are added mid-session.
- Handler selection derives from the requested name alone, and an unavailable tool produces an
  explicit, distinguishable refusal. Silence is what makes a refusal migratable to another handler.
- When the surface cannot be derived, the honest failure is to declare nothing. A previous call's
  answer is a different claim, and a stale declaration is this bug.

## The fix

`tool-surface.ts` (one per bridge lane, kept as a rename-diff clone) owns the derivation:
`reconcileToolSurface()` builds membership from the live session and returns the declarations for the
prompt, the MCP config, and the bridge guard from one source, plus `declaredToolNames` and
`registryUnreadable`. `resolveToolRequestDisposition()` classifies each requested name as `execute`,
`guard`, or `skip`, and the bridge turns `guard` into a visible refusal that carries
`TOOL_NOT_AVAILABLE` and states that the line is not an empty result. The schema-only MCP server now
refuses `tools/call` with a JSON-RPC error carrying the same marker instead of returning `null`.

## Verification

- Fail-before-fix is proven on the real entry point: with the pre-fix `index.ts` restored, the
  back-to-back test fails with `expected '/tmp/fusion-mcp-9bd0ddfee4ad.json' to be undefined`.
- The symptom assertion is the guard test that no `read`/`edit` tool call, guard text, or assistant
  text is emitted for an unavailable `fn_*` request, plus the schema-server test that a `tools/call`
  for an undeclared name is an error rather than a result.
- Both lanes carry the same tests, and `bridge-clone-parity.test.ts` holds the new modules to an exact
  rename-diff so a future fix cannot land in one lane only.

## Surface Enumeration

The invariant is asserted per routing surface, not per reproduction:

| Surface | Where the name is chosen | Assertion |
| --- | --- | --- |
| Claude bridge tool_use handling (coordination tools) | `pi-claude-cli/src/event-bridge.ts` via `resolveToolRequestDisposition` | `event-bridge-tool-surface-guard.test.ts`: declared executes, undeclared is refused, no tool call escapes the guard |
| Claude bridge (coding tools, internal CLI tools) | same disposition, `execute` / `skip` arms | coding tools keep their own name and args beside the guard block; internal tools stay silent |
| Back-to-back coordination calls after a coding-tool call | same, per `content_block` | the acceptance case: `Read`, then `fn_task_show` (declared) and `fn_read_messages` (undeclared) in one turn; exactly one `read` call exists |
| Droid bridge (same three surfaces) | `fusion-plugin-droid-runtime/src/event-bridge.ts` | the same test file as a rename-diff clone, plus `bridge-clone-parity.test.ts` |
| ACP warm-session transport (`streamViaAcp`) | `pi-claude-cli/src/acp-driver.ts` | `acp-driver.test.ts`: an undeclared `fn_task_show` emits no tool call and streams `TOOL_NOT_AVAILABLE` |
| Schema-only MCP server (`tools/call`) | `mcp-schema-server.cjs` in all three copies | `mcp-schema-server-tool-call.test.ts` per lane: an error, never a result, never a hang |
| Declared surface per turn (task-bound and heartbeat lanes alike) | `reconcileToolSurface()` in both `index.ts` entries | `tool-surface.test.ts` + `tool-surface-drift.test.ts`: revoked mid-session leaves, active-but-unnamed arrives, unreadable registry declares nothing |
| Engine lane (`packages/engine/src/pi.ts`) | pi's own `prepareToolCall` | no Fusion-side guard, by the forensic verdict: pi resolves `tools.find(t => t.name === toolCall.name)` and returns an explicit not-found error |

## Symptom Verification

Original symptom: an intended `fn_read_messages` in a heartbeat run executed as `read` with path
`/fusion/fn_read_messages` and returned `ENOENT`, and the intended `fn_list_agents` right after it did
the same.

Exact reproduction: a turn in which a coding-tool `tool_use` is followed by two `fn_*` requests, one
of them outside the turn's declared surface - the recipe the report gives ("once several coding-tool
calls have established a last used tool").

Assertion that it is gone: the acceptance test in
`packages/pi-claude-cli/src/__tests__/event-bridge-tool-surface-guard.test.ts` ("routes two
back-to-back coordination calls after a coding-tool call, each by its own name") shows the declared
coordination call executing under its own name and the undeclared one producing a refusal naming
itself, with exactly one `read` tool call in the turn's output. The declared surface can no longer
omit a tool the prompt named, which is what removed the affordance to confabulate a path. Green build
and the rest of the suite are not the evidence; that test is.

## What this does not claim

Sighting 3 was two intended `fn_read_messages` calls that ran as `fn_read_evaluations` and returned a
believable empty answer. In the recorded transcript the assistant turn itself named
`fn_read_evaluations`, and that tool *was* available. No dispatcher that honors "select by the
requested name" can rewrite that into the tool the agent meant, and pretending otherwise would mean
re-introducing exactly the prior-state guess this card removes. What is closable in-tree is the cause:
the declared surface used to diverge from what the prompt told the agent to call, and a model told to
call something it cannot see will substitute something it can. That divergence is now structurally
impossible, the refusal is unmistakable, and the run is left with a distinguishable record instead of
a plausible empty result.

## Do not

- Do not answer a derivation failure with a cached config path.
- Do not treat transcript replay as the authority for availability.
- Do not reintroduce a registry-wide custom-tool fallback.
- Do not silently drop a tool request; refuse it in a way the model cannot misread.
