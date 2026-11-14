/*
FNXC:SharedAgentStore 2026-11-11-13:45 (RUFU-591):
`GET /api/agents/stats` returned 157 bytes after 7.6 s because every request constructed a fresh
`AgentStore` and awaited `init()`, which itself re-lists every agent to provision the built-in
workflow-role agents. The store is a stateless access layer over PostgreSQL, so one initialized
instance per (options-identity) serves the whole server lifetime and the open-store tax is paid once.

Cache-key rule: the key covers EVERY behavior-changing option — `rootDir`, and the object identities
of `asyncLayer`, `taskStore`, and `claimStore`, plus `projectId` and `nodeId`. Object options are
keyed by identity through a WeakMap-minted token, never by serialization: `JSON.stringify`/`String()`
either throws on a cyclic store or reduces every layer to "[object Object]" and would silently merge
two distinct projects' stores into one entry. A site built with checkout semantics (taskStore/
claimStore present) can therefore never be served the bare read-only instance, and a replaced or
closed async layer resolves to its own entry instead of poisoning the previous one.

Lifecycle rules:
- Concurrent callers on one key join the single in-flight construct+init() promise, so two
  simultaneous first requests provision once instead of racing two instances that both write.
- A failed init is dropped (reference only), so the next request rebuilds instead of serving a
  half-provisioned store forever.
- LRU eviction DROPS THE MAP REFERENCE ONLY. `AgentStore extends EventEmitter` and closing an
  instance evicts the module-level SQLite handle cache for its rootDir, so a closing eviction could
  break a store another live request still holds. Evicted instances are simply garbage-collected
  once their last holder releases them. This module never calls close(), stopWatching(), or .on()
  on a shared instance.
*/
import type { AgentStore } from "@fusion/core";

/*
FNXC:AgentLinkBatchResolution 2026-11-11-15:10 (RUFU-591):
`AgentStoreOptions` is exported by the agent-store MODULE but not re-exported from the @fusion/core
package entry; deriving it from the constructor keeps this cache's key/options typing exactly aligned
with what `new AgentStore(...)` accepts, without widening the package's public export surface.
*/
type AgentStoreOptions = NonNullable<ConstructorParameters<typeof AgentStore>[0]>;

/** Bound on distinct option shapes kept alive; each entry retains its AgentStore (and through it
 *  the asyncLayer object identity), so an unbounded map would retain every replaced layer forever. */
const MAX_SHARED_STORES = 8;

const objectTokens = new WeakMap<object, number>();
let nextObjectToken = 1;

/** Identity token for an object-valued option: stable while the object is alive, and a fresh token
 *  can never collide with a dead one's because tokens are never reused. */
function identityToken(value: object | undefined | null): string {
  if (value === undefined) return "u";
  if (value === null) return "n";
  let token = objectTokens.get(value);
  if (token === undefined) {
    token = nextObjectToken++;
    objectTokens.set(value, token);
  }
  return `o${token}`;
}

/** Full-option key: primitives appear as values, objects as identity tokens. Only this composed
 *  string (never a caller object) is serialized, so a cyclic store can never reach stringify. */
function sharedStoreKey(options: AgentStoreOptions): string {
  return JSON.stringify([
    options.rootDir ?? "",
    identityToken(options.asyncLayer),
    identityToken(options.taskStore),
    identityToken(options.claimStore),
    options.projectId ?? "",
    options.nodeId ?? "",
  ]);
}

interface SharedEntry {
  /** One construct+init() pass; concurrent joiners await this same promise. */
  readonly promise: Promise<AgentStore>;
}

/*
FNXC:SharedAgentStore 2026-11-14-15:05 (RUFU-591):
The RUFU-257 retention census classifies this map `bounded`: every distinct option shape inserts one
entry, so cardinality is traffic-shaped unless the LRU below reclaims it, and `MAX_SHARED_STORES` is
the declared ceiling that eviction enforces on every insert.
*/
// retention-bounded: MAX_SHARED_STORES
const sharedEntries = new Map<string, SharedEntry>();

/**
 * Return the memoized, already-`init()`ed `AgentStore` for exactly these options.
 *
 * Converts a per-request `new AgentStore(...) + await init()` into one open per option shape for
 * the server's lifetime. Call sites MUST satisfy the RUFU-591 conversion gate: bare read-only
 * options, no listener attached to the returned instance, and no `close()`/`stopWatching()` path —
 * checkout/release sites that pass `taskStore`/`claimStore` intentionally resolve to their own
 * entry and are never served a shared read-only instance (and vice versa).
 */
export async function getSharedAgentStore(options: AgentStoreOptions): Promise<AgentStore> {
  const key = sharedStoreKey(options);
  const existing = sharedEntries.get(key);
  if (existing) {
    // LRU touch: re-insert so the entry becomes the most-recently-used.
    sharedEntries.delete(key);
    sharedEntries.set(key, existing);
    return existing.promise;
  }

  const entry: SharedEntry = {
    promise: (async () => {
      const { AgentStore } = await import("@fusion/core");
      const store = new AgentStore({ ...options });
      await store.init();
      return store;
    })(),
  };
  sharedEntries.set(key, entry);
  while (sharedEntries.size > MAX_SHARED_STORES) {
    const oldest = sharedEntries.keys().next();
    if (oldest.done) break;
    // Drop-reference-only eviction: never close the evicted instance (see FNXC block above).
    sharedEntries.delete(oldest.value);
  }

  try {
    return await entry.promise;
  } catch (err) {
    // A failed init must not stay cached: drop the reference so the next request rebuilds.
    if (sharedEntries.get(key) === entry) sharedEntries.delete(key);
    throw err;
  }
}

/** Test seam: report how many distinct option shapes currently hold a shared entry. */
export function sharedAgentStoreCacheSize(): number {
  return sharedEntries.size;
}

/** Test seam: forget all shared entries WITHOUT closing any instance (drop-reference-only). */
export function resetSharedAgentStoreCacheForTests(): void {
  sharedEntries.clear();
}
