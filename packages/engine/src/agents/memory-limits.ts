/**
 * Dependency-free leaf for the injected-memory size limit.
 *
 * FNXC:MemoryInlineClamp 2026-11-21-06:49 (RUFU-824):
 * Two modules independently declared `50_000` for the same contract, so a change to one silently
 * desynchronised the other:
 * - `./agent-instructions.ts` uses it as the INJECTION-TIME clamp (`clampMemoryKeepingNewest`) that
 *   decides how much memory actually enters a prompt, and its omission notice quotes it.
 * - `../agent-tools.ts` uses it in `createUpdateIdentityTool` to REFUSE an oversized inline `memory`
 *   write, and `agent-self-improve.test.ts` builds `MAX_MEMORY_LENGTH + 1` from the
 *   `agent-instructions.ts` export while asserting the tool rejects it — i.e. the test proves the two
 *   numbers agree only because they happen to be equal, which is coincidence, not a guard.
 * This module is the single definition, so the two consumers cannot drift by construction.
 *
 * It is a leaf with no imports on purpose. `agent-instructions.ts` already imports
 * `readAgentMemoryWorkspaceLongTerm` from `../agent-tools.js`, so `agent-tools.ts` may never import
 * from `agent-instructions.js` directly; routing both consumers through this leaf is what keeps that
 * cycle out. Do not add imports here.
 *
 * Unit and value are contractual, not incidental: characters (UTF-16 code units), not bytes. See
 * `docs/memory-plugin-contract.md` §1.2 for why 50,000 characters is the chat-window-safe figure
 * (`FNXC:ChatContextBudget 2026-08-20-11:56`) and how this limit differs from
 * `MEMORY_LONG_TERM_BYTE_BUDGET`, which is a write-time byte budget on a different surface.
 */
export const MAX_MEMORY_LENGTH = 50_000;
