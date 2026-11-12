/**
 * RUFU-938 — engine presence for a dashboard process that owns no engine manager.
 *
 * `/api/health` and `/api/engine/status` used to answer "no engine" from one fact: this process has
 * no `ProjectEngineManager`. In the split deployment the operator measures (a UI-only host beside a
 * real engine host, one shared database) that answer is false, and it is not merely inaccurate — the
 * two panels it drives tell the operator to stop this server and run `pnpm local` / `fn dashboard`,
 * which would take down the engine that is currently serving the board.
 *
 * This module is the manager-free half of the liveness question. It reads exactly one thing another
 * process published: the engine singleton's loopback address (see
 * `packages/engine/src/project/engine-singleton-lock.ts`). The rule that makes it safe to call from
 * a 10-second status poll and a 20-second health refresh is that every function here is read-only and
 * fail-closed:
 *
 *   - it never acquires the singleton, never binds, never unlinks a stale socket, and never builds
 *     an engine, so the probe can never start the thing it is asking about;
 *   - a probe that throws, rejects, or names no project resolves `false`. "Cannot see an engine" and
 *     "engine is down" are the same answer to a fail-closed reader, and that is the direction this
 *     file must err in — claiming a live engine without evidence would suppress the one banner that
 *     tells an operator with a genuinely engine-less host what to do.
 *
 * What it cannot see is an engine on ANOTHER machine: the singleton address is per-machine. That is
 * why `buildEngineStatusPayload` pairs this signal with the running-agent count from already-open
 * stores, which is shared-database evidence and covers a remote engine that is actively working.
 */

import { probeEngineSingletonPresence } from "@fusion/engine";

/** Ask whether one project's engine singleton is held by a live process. Injectable for tests. */
export type EnginePresenceProbe = (projectId: string) => Promise<boolean>;

/** The production probe: a connect-only read of the engine singleton's loopback address. */
export const singletonLockPresenceProbe: EnginePresenceProbe = (projectId) =>
  probeEngineSingletonPresence(projectId);

/**
 * Whether THIS project's engine is held by a live process on this machine.
 *
 * A missing id, a throwing probe, and a rejected probe all resolve `false` — the reader is
 * fail-closed by contract, so a liveness answer never becomes a request failure.
 */
export async function isEngineSingletonLive(
  projectId: string | undefined,
  probe: EnginePresenceProbe = singletonLockPresenceProbe,
): Promise<boolean> {
  if (!projectId) return false;
  try {
    return (await probe(projectId)) === true;
  } catch {
    return false;
  }
}

/**
 * Whether ANY of the candidate projects has a live engine on this machine.
 *
 * Backs the machine-scoped `engine.available` health field, which names no project. Probes run
 * concurrently and each result is judged on its own (`allSettled`), so one unreadable address cannot
 * erase another project's positive proof, and a host with no candidates answers `false` without
 * touching the network at all.
 */
export async function anyEngineSingletonLive(
  candidateProjectIds: readonly string[],
  probe: EnginePresenceProbe = singletonLockPresenceProbe,
): Promise<boolean> {
  const ids = dedupePresenceCandidates(candidateProjectIds);
  if (ids.length === 0) return false;
  const results = await Promise.allSettled(ids.map((id) => probe(id)));
  return results.some((result) => result.status === "fulfilled" && result.value === true);
}

/**
 * The project identities a manager-free host may ask about, from facts it already holds.
 *
 * Deliberately narrow: registered (already-open) project stores plus the central default project id.
 * An unregistered project is never opened to answer a liveness question — that is the same discipline
 * `resolveRunningAgentCountFromOpenStores` states for the count, and here it also keeps a health
 * refresh from turning into project initialization. A resolver that throws contributes nothing rather
 * than failing the caller.
 */
export function dedupePresenceCandidates(
  candidateProjectIds: readonly (string | undefined | null)[],
): string[] {
  const seen = new Set<string>();
  for (const id of candidateProjectIds) {
    if (typeof id !== "string") continue;
    const trimmed = id.trim();
    if (trimmed.length > 0) seen.add(trimmed);
  }
  return [...seen];
}

/** Build the candidate reader over the host's already-known project identities. */
export function createPresenceCandidateReader(deps: {
  listRegisteredProjectIds?: () => readonly string[];
  resolveDefaultProjectId?: () => Promise<string | null | undefined>;
}): () => Promise<string[]> {
  return async (): Promise<string[]> => {
    const ids: Array<string | undefined | null> = [];
    try {
      ids.push(...(deps.listRegisteredProjectIds?.() ?? []));
    } catch {
      // A registry read that fails only narrows the candidate set; it is never a liveness claim.
    }
    try {
      ids.push(await deps.resolveDefaultProjectId?.());
    } catch {
      // Same: an unreadable default contributes no candidate.
    }
    return dedupePresenceCandidates(ids);
  };
}
