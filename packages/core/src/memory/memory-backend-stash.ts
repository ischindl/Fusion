/**
 * Stash Agent Memory backend for Fusion.
 *
 * Exposes the operator's Stash knowledge-base (~/git/stash) as an optional LCM
 * memory backend. Stash is a self-hosted personal memory/knowledge server that
 * stores timestamped events (conversation turns, tool calls, notes) and exposes
 * full-text search over them.
 *
 * Transport: REST (pi-plugin-rewrite), NOT MCP.
 *   - SEARCH (read):  GET  /api/v1/me/sessions/events/search?q=<query>&limit=<n>
 *   - CAPTURE (write): POST /api/v1/me/sessions/events/batch
 * Auth: `Authorization: Bearer <stash API key>`.
 *
 * FNXC:StashBackend 2026-08-05-16:06:
 * The original RUFU-026 brief referenced an MCP server at /api/v1/mcp with
 * stash_session_search / stash_session_upload / stash_memory_append tools.
 * That was VERIFIED WRONG against the current stash checkout
 * (pi-plugin-rewrite): there is no /api/v1/mcp, no mcp_service.py, no such
 * MCP tools. The current stash exposes search + capture via REST only. This
 * backend is a minimal fetch-based REST client over the two endpoints and does
 * NOT use @modelcontextprotocol/sdk.
 *
 * Callers choosing the stash backend must supply auth + isolation via the
 * MemoryBackend constructor options:
 *   - apiKey: the stash API key (read from secrets store, NEVER hardcoded).
 *   - baseUrl: the stash server URL (defaults to http://127.0.0.1:3457).
 *
 * Source of truth: `stashUrl`/`stashApiKey` come from project settings +
 * the global secrets store. Project value wins over global; unset falls back
 * to the default base URL.
 */

import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { createLogger } from "../process/logger.js";
import { emitBoundedRunAudit, type RunAuditLogger, type RunAuditSinkHost } from "../run-audit/emit-bounded-run-audit.js";
import type { RunAuditMutationType } from "../types/audit/run-audit.js";
import type {
  MemoryBackend,
  MemoryBackendCapabilities,
  MemoryReadResult,
  MemoryWriteResult,
  MemoryGetOptions,
  MemoryGetResult,
  MemorySearchOptions,
  MemorySearchResult,
  MemoryCaptureEvent,
  MemoryCaptureResult,
  MemoryWriteIdentity,
} from "./memory-backend.js";
import {
  resolveStashMemorySettings,
  type MemoryBackendSettings,
  type StashSecretsReader,
} from "./stash-settings.js";
import { hygieneStashItems, labelStashRanking } from "./stash-result-hygiene.js";

// ── Types ────────────────────────────────────────────────────────────

/** One captured event stored in stash. */
export interface StashEvent extends MemoryCaptureEvent {
  /** top-level stash-required session id (MemoryCaptureEvent has no such field). */
  session_id?: string;
  /**
   * FNXC:RUFU121FolderAssignment 2026-08-18-19:53:
   * RUFU-121: top-level per-project session-folder id (Stash
   * HistoryEventCreateRequest.session_folder_id, UUID | null). Stamped by
   * capture()/write() when a project identity resolves.
   */
  session_folder_id?: string;
}

interface StashSearchResultItem {
  id?: string | number;
  content?: string;
  event_type?: string;
  agent_name?: string;
  session_id?: string;
  created_at?: string;
  snippet?: string;
  /**
   * FNXC:StashReadScope 2026-11-19-13:41 (RUFU-1008):
   * Declared so the read-side identity check reads a shape rather than guessing one: the live server
   * returns `metadata` on both search routes with `discriminator` inside it (measured 2026-11-19),
   * and that value is what isolates one Fusion project's rows from another's at read time.
   */
  metadata?: { discriminator?: unknown; [key: string]: unknown } | null;
  /**
   * FNXC:RUFU133StashScore 2026-08-25-20:17:
   * RUFU-133: raw FTS rank (Stash ts_rank) when the deployed image supplies
   * it — the tier-2 relevance input. Declared `number` to document the
   * expected JSON shape, but runtime values arrive untyped through the
   * response cast (catch-all below), so the mapping helper guards, not
   * trusts.
   */
  rank?: number;
  /**
   * FNXC:RUFU133StashScore 2026-08-25-20:17:
   * RUFU-133: server-provided per-event relevance score (normalized
   * ts_rank) shipped by the local Stash branch
   * `fusion-rufu-133-keyword-score` (undeployed). The tier-1 relevance
   * input, clamped to [0,1] by the mapping helper.
   */
  score?: number;
  [key: string]: unknown;
}

interface StashSearchResponse {
  results?: StashSearchResultItem[];
  events?: StashSearchResultItem[];
  count?: number;
  [key: string]: unknown;
}

interface StashBatchResponse {
  inserted?: number;
  deduped?: number;
  count?: number;
  [key: string]: unknown;
}

// ── HTTP transport seam (RUFU-121) ────────────────────────────────────

/**
 * FNXC:RUFU121TransportSeam 2026-08-18-19:53:
 * RUFU-121: injectable HTTP transport seam for the Stash backend and the
 * standalone Stash helpers (queryStashEvents/deleteStashChatSession). Tests
 * inject a recorder fake — no real network in unit tests.
 */
export type StashHttpMethod = "GET" | "POST" | "PATCH" | "DELETE";
export type StashHttpClient = (
  path: string,
  method: StashHttpMethod,
  payload?: unknown,
) => Promise<unknown>;

/**
 * FNXC:RUFU121TransportSeam 2026-08-18-19:53:
 * RUFU-121: the real node:http JSON transport (moved out of
 * StashMemoryBackend.httpRequest so standalone helpers share it without a
 * backend instance). Same wire behavior as before: 10s timeout, Bearer auth,
 * JSON body, 2xx → parsed body (or null), otherwise reject.
 *
 * FNXC:StashTransportScheme 2026-08-21-13:35:
 * RUFU-146 review (PRRT_kwDOSA-8Y86a7RZf): the transport must follow the
 * baseUrl scheme. Self-hosted Stash deployments sit behind TLS reverse
 * proxies, and the default operator setup is a non-loopback https URL — the
 * previous unconditional node:http.request made every such deployment fail
 * with an http/https protocol mismatch. Select node:https for `https:`
 * bases, node:http otherwise, and preserve any base-URL path prefix (e.g.
 * http://host/stash) so proxied deployments keep their /stash routing.
 */
export function stashHttpJsonRequest<T>(
  baseUrl: string,
  apiKey: string,
  path: string,
  method: StashHttpMethod,
  payload?: unknown,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // Resolve `path` against the full base URL INCLUDING its path prefix:
    // `new URL("/api/v1/…", "http://host/stash")` drops the /stash segment,
    // so strip the leading slash and let URL resolution re-append it.
    const url = new URL(path.startsWith("/") ? path.slice(1) : path, baseUrl.replace(/\/+$/, "") + "/");
    const body = payload !== undefined ? JSON.stringify(payload) : undefined;
    const headers: http.OutgoingHttpHeaders = { Accept: "application/json" };
    if (body) headers["Content-Type"] = "application/json";
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers,
      timeout: 10_000,
    };

    // FNXC:StashTransportScheme 2026-08-21-13:35: transport follows the scheme.
    const req = (url.protocol === "https:" ? https : http).request(options, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve((data ? JSON.parse(data) : null) as T);
          } catch {
            reject(new Error(`Invalid JSON response (${res.statusCode}): ${data.substring(0, 200)}`));
          }
        } else {
          reject(new Error(`Stash returned ${res.statusCode}: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on("error", (err) => reject(err));
    req.on("timeout", () => { req.destroy(); reject(new Error("Stash request timed out")); });

    if (body) req.write(body);
    req.end();
  });
}

// ── Defaults ─────────────────────────────────────────────────────────

export const DEFAULT_STASH_URL = "http://127.0.0.1:3457";

/*
FNXC:StashReadAuth 2026-11-12-19:34 (RUFU-994):
The ONE baseUrl derivation, shared by the backend's own construction and by every reader of
`getStashReadOutcome`. The read-outcome map is keyed by the baseUrl the backend normalized, so a
reader that re-derived it a different way (no trim, no trailing-slash strip) would ask about a
server nobody contacted and report "no outcome" beside a refusal that had just happened. Keep this
in lock-step with the `StashMemoryBackend` constructor. The parameter is `unknown` on purpose:
callers hold three different settings shapes (`Settings`, `Partial<Settings>`, and core's
structurally-indexed `MemorySettings`) and only `stashUrl` is ever read, so a narrower parameter
type would force a cast at every call site.
*/
export function stashBaseUrlFromSettings(settings?: unknown): string {
  const url = (settings as { stashUrl?: unknown } | undefined)?.stashUrl;
  const raw = typeof url === "string" && url.trim().length > 0 ? url.trim() : DEFAULT_STASH_URL;
  return raw.replace(/\/+$/, "");
}

/*
FNXC:RUFU122ChunkedUpload 2026-08-19-04:30:
RUFU-122: Stash's /events/batch endpoint rejects a POST carrying more than 100
events (verified against the live instance in preflight — the 200 cap from the
earlier RUFU-068 spec was wrong). capture() therefore uploads transcripts in
sequential chunks of this size; any single capture exceeding it (the task
terminal transcript, up to 20000 events) is split, never silently truncated.
*/
export const STASH_EVENT_BATCH_CHUNK_SIZE = 100;

/**
 * FNXC:RUFU121FolderCache 2026-08-18-19:53:
 * RUFU-121 per-process session-folder cache. Key `${baseUrl}::${projectId}`
 * — the baseUrl segment guarantees different Stash instances (or test fakes)
 * never share a folder id. Successes only, TTL 1h; failures are never cached
 * (fail-open, retried on the next capture). __resetStashFolderCacheForTests()
 * clears it for test isolation.
 */
const STASH_FOLDER_CACHE_TTL_MS = 3_600_000;
const stashFolderCache = new Map<string, { folderId: string; expiresAt: number }>();

/** RUFU-121 test seam: clear the per-process session-folder cache. */
export function __resetStashFolderCacheForTests(): void {
  stashFolderCache.clear();
}

/*
FNXC:Rufu126VectorSearch 2026-08-19-10:50:
RUFU-126 (D3): per-process NEGATIVE vector-capability cache. Keyed by baseUrl
only (vector capability is a property of the Stash instance, not the project).
Records ONLY definitive "this server cannot do vector search" responses —
404 (unpatched server, no /events/semantic-search route), 405, 501, and 503
(embedder unconfigured) — parsed from the transport's `Stash returned <code>:`
rejection prefix. 422/500 and network errors are NEVER cached (transient or
malformed — retry on the next call). TTL 1h, mirroring the session-folder
cache; __resetVectorCapabilityCacheForTests() clears it for test isolation.

FNXC:StashReadAuth 2026-11-12-20:09 (RUFU-994):
The definitive set widens to include 401 and 403. The card's operator measured 2 334 semantic-search
calls and 2 334 x 401 from ONE process: with `stashVectorSearch: true` every recall turn burned the
semantic request, got refused, fell through to keyword, and burned it again on the next turn. A
refused credential is as definitive for this window as an absent route — nothing changes until the
secret or the grant changes. Two halves of the old contract stay exactly as they were: the keyword
fallback still runs on every call (only the semantic attempt is suppressed), and 422/500/network
still are never cached. Because the window is the same TTL, a rotated or newly-installed key is
re-probed when the window expires, not on the next turn — that is the accepted cost, and
`getStashReadOutcome` keeps reporting the cause while the window stands.
*/
const STASH_VECTOR_NEGATIVE_CACHE_TTL_MS = 3_600_000;
/** Statuses that suppress further semantic attempts for one TTL window (RUFU-994: + 401, 403). */
const STASH_VECTOR_NEGATIVE_STATUSES: ReadonlySet<number> = new Set([401, 403, 404, 405, 501, 503]);
/** Exported so a test pins the bound rather than the 3_600_000 literal. */
export const STASH_VECTOR_CAPABILITY_TTL_MS = STASH_VECTOR_NEGATIVE_CACHE_TTL_MS;
const stashVectorNegativeCache = new Map<string, { expiresAt: number }>();

/** RUFU-126 test seam: clear the per-process negative vector-capability cache. */
export function __resetVectorCapabilityCacheForTests(): void {
  stashVectorNegativeCache.clear();
}

/*
FNXC:StashReadAuth 2026-11-12-19:34 (RUFU-994):
A refused Stash READ used to be indistinguishable from an empty one. The four read swallow sites
(`read()`, keyword `search()`, `vectorSearchHits()`, `exists()`) each caught everything and returned
`[]` / `""` / `false`, which is the correct fail-closed contract but made 2334 x 401 look exactly
like "this project has no memories" — the defect survived 3 months for that reason alone. The
operator's requirement: "polozka, kde recall zlyhal pre auth, sa musi lisit od polozky, kde naozaj
nie je nic najst".

So every read attempt now records ONE outcome per baseUrl in this bounded map, from a closed set of
deterministic codes. The map is the same shape as `stashFolderCache` / `stashVectorNegativeCache`
(module-level, per-process, baseUrl-keyed, insert-order eviction) and is pure signal: the return
values callers see are unchanged, and nothing here may turn a refused read into a throw.

Code meanings — `no-match` and `refused-auth` are the pair the operator asked to separate:
- `ok`                 the endpoint answered 2xx with at least one result.
- `no-match`           the endpoint answered 2xx with zero results (or the query normalized to "",
                       which sends no request at all). Genuinely empty, not a failure.
- `key-unresolved`     this backend holds no credential, so whatever the server answered, WE sent
                       nothing. Named ahead of any status so our-side configuration never reads as a
                       server-side refusal; `keyResolved: false` accompanies it in the audit row.
- `refused-auth`       401/403 with a credential actually sent — Stash rejected a key it received.
- `refused-capability` 404/405/501/503 — the route is absent or the feature is unconfigured.
- `rejected-request`   any other non-2xx (400/422/500/…).
- `unreachable`        transport-level failure with no status (connection refused, timeout, DNS).
- `malformed`          2xx whose body could not be parsed as the expected JSON shape.

Nothing here may carry key material, a URL with a query string, a response body, or an exception
message — the map stores only the fixed code, the fixed endpoint id, a boolean and a count.
*/

/** Fixed read-endpoint ids. An id names the route; a URL never enters this record. */
export const STASH_READ_ENDPOINTS = ["keyword-search", "semantic-search", "read", "exists"] as const;
export type StashReadEndpoint = (typeof STASH_READ_ENDPOINTS)[number];

/** Closed read-outcome vocabulary (see the FNXC block above for each meaning). */
export const STASH_READ_OUTCOME_CODES = [
  "ok",
  "no-match",
  "key-unresolved",
  "refused-auth",
  "refused-capability",
  "rejected-request",
  "unreachable",
  "malformed",
] as const;
export type StashReadOutcomeCode = (typeof STASH_READ_OUTCOME_CODES)[number];

/** What one read attempt left behind, readable by the memory routes and by tests. */
export interface StashReadOutcome {
  code: StashReadOutcomeCode;
  endpoint: StashReadEndpoint;
  /** False when this backend held no credential at the moment of the attempt. */
  keyResolved: boolean;
  /** Results the caller received (0 for every refusal and for `no-match`). */
  resultCount: number;
  /** Epoch ms of the attempt that produced the record. */
  at: number;
}

/** Bound mirrors the other Stash maps: distinct Stash servers per process are a small number. */
const STASH_READ_DIAGNOSTICS_MAX = 64;

/*
 * One entry per baseUrl, holding the most recent outcome plus the most recent outcome PER
 * ENDPOINT. The single "last" record is the operator-facing answer the memory routes surface; the
 * per-endpoint half exists because the RUFU-126 vector lane falls THROUGH into the keyword route,
 * so a semantic refusal that arrived first would otherwise be overwritten by the keyword success
 * that followed it — and semantic-search is precisely the endpoint that measured 2334 refusals.
 * A `Partial` keyed by the closed endpoint list cannot grow past four keys, so the map stays bounded.
 */
const stashReadDiagnostics = new Map<
  string,
  { last: StashReadOutcome; endpoints: Partial<Record<StashReadEndpoint, StashReadOutcome>> }
>();

function recordStashReadOutcome(
  baseUrl: string,
  outcome: Omit<StashReadOutcome, "at">,
  nowMs: number,
): void {
  const stamped: StashReadOutcome = { ...outcome, at: nowMs };
  const entry = stashReadDiagnostics.get(baseUrl);
  if (entry) {
    entry.last = stamped;
    entry.endpoints[outcome.endpoint] = stamped;
    return;
  }
  if (stashReadDiagnostics.size >= STASH_READ_DIAGNOSTICS_MAX) {
    // Insert-order eviction, mirroring how the folder/vector caches bound themselves.
    const oldest = stashReadDiagnostics.keys().next();
    if (!oldest.done) stashReadDiagnostics.delete(oldest.value);
  }
  stashReadDiagnostics.set(baseUrl, { last: stamped, endpoints: { [outcome.endpoint]: stamped } });
}

/**
 * Last read outcome recorded for a Stash server — or for one named endpoint of it — or null when
 * this process has read nothing from it. `undefined` baseUrl (no configured server) answers null
 * rather than guessing a default host.
 */
export function getStashReadOutcome(
  baseUrl?: string,
  endpoint?: StashReadEndpoint,
): StashReadOutcome | null {
  if (!baseUrl) return null;
  const entry = stashReadDiagnostics.get(baseUrl);
  if (!entry) return null;
  return endpoint ? entry.endpoints[endpoint] ?? null : entry.last;
}

/** Every endpoint record this process holds for one Stash server. */
function listStashReadOutcomes(baseUrl: string): StashReadOutcome[] {
  const entry = stashReadDiagnostics.get(baseUrl);
  if (!entry) return [];
  const rows: StashReadOutcome[] = [];
  for (const endpoint of STASH_READ_ENDPOINTS) {
    const outcome = entry.endpoints[endpoint];
    if (outcome) rows.push(outcome);
  }
  return rows;
}

/*
FNXC:StashReadAuth 2026-11-12-19:41 (RUFU-994):
The diagnostics map answers "what happened last, in this process". The audit row answers the same
question after a restart, and it is what makes the operator's original measurement reproducible as a
query instead of a container log: semantic-search refused 2334 times while batch capture returned
201 a few metres away. One row per (baseUrl, code) per refresh floor, through the FN-9177 bounded
core seam, so an absent / throwing / rejecting / never-settling sink cannot alter, delay, or fail the
recall it reports.

What may enter the row: the endpoint id, the closed code, `keyResolved`, and a count. NOT the baseUrl
— a Stash URL may legitimately carry credentials in its userinfo segment, and the audit store is
readable by anything with query access (the same rule FN-9059 states for remote URLs) — so the URL
stays the map's internal dedupe key and the `runId` names the (endpoint, code) pair instead.

Codes that are not refusals (`ok`, `no-match`) write no row: `no-match` is the honest empty answer,
and auditing it would bury the refusals under the traffic the operator is trying to count.
*/

/** The run-audit id. Declared in `@fusion/core`'s closed `RunAuditMutationType` union. */
export const STASH_READ_REFUSAL_MUTATION_TYPE: RunAuditMutationType = "memory:stash-read-refused";

/** Synthetic agent id — a memory read belongs to no lane and no durable agent. */
const STASH_READ_AUDIT_AGENT_ID = "memory-read";

/**
 * One refusal per (baseUrl, code) per window. A busy chat lane recalls every turn, and a standing
 * misconfiguration would otherwise write a row per turn; 15 min matches the RUFU-393 stall-record
 * floor, so a sustained refusal stays countable without becoming a flood.
 */
export const STASH_READ_REFUSAL_AUDIT_REFRESH_FLOOR_MS = 15 * 60_000;

/** Codes worth a row. `ok` and `no-match` are deliberately absent (see the block above). */
const STASH_READ_REFUSAL_CODES: ReadonlySet<StashReadOutcomeCode> = new Set([
  "key-unresolved",
  "refused-auth",
  "refused-capability",
  "rejected-request",
  "unreachable",
  "malformed",
]);

const stashReadAuditLog = createLogger("core-memory-stash-read");
const lastStashReadAuditAt = new Map<string, number>();

/** Test seam: forget the dedupe markers so a suite can observe a fresh emission. */
export function __resetStashReadAuditDedupeForTests(): void {
  lastStashReadAuditAt.clear();
}

/**
 * The store a memory read entry already holds. One `TaskStore` satisfies both duck types: the
 * secrets reader the ONE resolver needs and the bounded audit seam's host. No new store is opened
 * for telemetry, which is why the read paths can emit at all.
 */
type RunAuditHostShape = Exclude<RunAuditSinkHost, null | undefined>;
export type StashReadStoreHost = StashSecretsReader & RunAuditHostShape;

/**
 * Record the refusals this process saw from one Stash server: at most one audit row and one warn
 * line per (baseUrl, code) per window. Fire-and-forget by contract — it never awaits the sink, so
 * it cannot delay a recall, and it swallows its own failure because a diagnostic that can break a
 * read is worse than no diagnostic.
 */
export function reportStashReadOutcome(
  host: StashReadStoreHost | null | undefined,
  baseUrl: string | undefined,
  opts: { nowMs?: number; refreshFloorMs?: number; log?: RunAuditLogger } = {},
): void {
  if (!baseUrl) return;
  const nowMs = opts.nowMs ?? Date.now();
  const floorMs = opts.refreshFloorMs ?? STASH_READ_REFUSAL_AUDIT_REFRESH_FLOOR_MS;
  const log: RunAuditLogger = opts.log ?? stashReadAuditLog;
  try {
    for (const outcome of listStashReadOutcomes(baseUrl)) {
      if (outcome.code === "ok" || outcome.code === "no-match") continue;
      if (!STASH_READ_REFUSAL_CODES.has(outcome.code)) continue;
      const dedupeKey = `${baseUrl}\u0000${outcome.code}`;
      const lastAt = lastStashReadAuditAt.get(dedupeKey);
      if (lastAt !== undefined && lastAt + floorMs > nowMs) continue;
      // Bounded like the seam's own notice throttle: keys are (server, code), never unbounded.
      if (lastStashReadAuditAt.size >= 256) lastStashReadAuditAt.clear();
      lastStashReadAuditAt.set(dedupeKey, nowMs);
      // Codes are fixed literals and endpoints are fixed ids: no key, URL, body, or error text here.
      log.warn(
        `[memory] stash read refused code=${outcome.code} endpoint=${outcome.endpoint} keyResolved=${outcome.keyResolved}`,
      );
      void emitBoundedRunAudit(
        host,
        {
          agentId: STASH_READ_AUDIT_AGENT_ID,
          runId: `${STASH_READ_REFUSAL_MUTATION_TYPE}:${outcome.endpoint}:${outcome.code}`,
          domain: "database",
          mutationType: STASH_READ_REFUSAL_MUTATION_TYPE,
          target: "stash-memory",
          metadata: {
            endpoint: outcome.endpoint,
            code: outcome.code,
            keyResolved: outcome.keyResolved,
            resultCount: outcome.resultCount,
          },
        },
        { log },
      );
    }
  } catch {
    // Swallowed on purpose: the row and the log line are the record, and neither may become
    // a lifecycle dependency of the read it describes.
  }
}

/** RUFU-994 test seam: clear the per-process read-outcome map. */
export function __resetStashReadDiagnosticsForTests(): void {
  stashReadDiagnostics.clear();
  // RUFU-1008: the scope counters share this reset so a suite cannot inherit another case's
  // drop counts (the dedupe markers below would otherwise stay armed across cases).
  stashReadScopeDiagnostics.clear();
  lastStashReadScopeAuditAt.clear();
}

/*
FNXC:StashReadScope 2026-11-19-13:41 (RUFU-1008):
"The project's memory is empty" and "recall found rows that belong to another project" are two
truths, and an operator must be able to tell them apart from a board surface — the same demand
RUFU-994 raised about `auth-rejected`, which is why this is a SEPARATE record and never folded into
`getStashReadOutcome`: "we were not allowed to look" and "what we saw is not ours" need different
repairs.

Keyed by the PAIR (baseUrl, discriminator), not by the server alone: one Stash daemon serves every
project of one operator inside one process, so a baseUrl-keyed counter would show project A's dropped
rows on project B's settings page — reproducing the leak on the diagnostics surface.
*/

/** Bound mirrors `STASH_READ_DIAGNOSTICS_MAX`: (server, project) pairs per process are small. */
const STASH_READ_SCOPE_DIAGNOSTICS_MAX = 64;

/**
 * What this process last has to say about one (server, project) pair. Counts and a fixed class only.
 *
 * FNXC:StashReadScope 2026-11-19-16:08 (RUFU-1008 code review, P1):
 * `at` is the instant of the read that PRODUCED the record, not the instant of the most recent read
 * for the pair: a drop-class record is sticky (see `recordStashReadScope`), so a later clean read
 * never re-stamps it. A reader that needs to weigh staleness therefore has the honest clock here.
 */
export interface StashReadScope {
  outcome: StashReadScopeOutcomeCode;
  /** Rows the server answered before scoping (`ownCount` + both drop counts). */
  matchedCount: number;
  ownCount: number;
  droppedForeignCount: number;
  droppedUnidentifiedCount: number;
  /** The `limit` the caller asked for — lets a reader see whether the class filled the window. */
  limit: number;
  /** Epoch ms of the scoped read that produced the record. */
  at: number;
}

const stashReadScopeDiagnostics = new Map<string, StashReadScope>();

function scopeDiagnosticsKey(baseUrl: string, discriminator: string): string {
  // Same separator discipline as the refusal dedupe key: a NUL cannot appear in a URL or a slug.
  return `${baseUrl}\u0000${discriminator}`;
}

/*
FNXC:StashReadScope 2026-11-19-16:08 (RUFU-1008 code review, P1):
A drop-class record is STICKY: an `all-own` read never overwrites a recorded
`dropped-foreign` / `dropped-unidentified` for the same (server, project) pair. The reason is the
per-turn recall lane, which is the highest-frequency Stash reader and the one that produced the
reported symptom: `buildPerTurnMemoryRecallCue()` searches twice (lane P project keywords, lane T
focus terms) and reports ONCE, after both. If lane P's answer contained foreign rows and lane T's
focus query happened to answer with only own rows, a last-write-wins record read at report time says
`all-own`, and `reportStashReadScope` returns immediately on `all-own` — no audit row, no warn line,
and both operator surfaces show zero drops. AC4's "empty versus dropped" distinction would then be
lost on exactly the lane that leaks. A clean read cannot un-happen a read that returned another
project's rows, so the worse class survives; a newer DROP still overwrites an older drop (the latest
drop is the relevant one), and `at` keeps the timestamp of the read that earned it.
*/
function recordStashReadScope(
  baseUrl: string,
  discriminator: string,
  scope: Omit<StashReadScope, "at">,
  nowMs: number,
): void {
  const key = scopeDiagnosticsKey(baseUrl, discriminator);
  const existing = stashReadScopeDiagnostics.get(key);
  if (existing && scope.outcome === "all-own" && existing.outcome !== "all-own") return;
  const stamped: StashReadScope = { ...scope, at: nowMs };
  if (stashReadScopeDiagnostics.has(key) || stashReadScopeDiagnostics.size < STASH_READ_SCOPE_DIAGNOSTICS_MAX) {
    stashReadScopeDiagnostics.set(key, stamped);
    return;
  }
  // Insert-order eviction, mirroring every other Stash map in this module.
  const oldest = stashReadScopeDiagnostics.keys().next();
  if (!oldest.done) stashReadScopeDiagnostics.delete(oldest.value);
  stashReadScopeDiagnostics.set(key, stamped);
}

/**
 * Scoped-read record for one (Stash server, project) pair, or null when this process has read nothing
 * for it. Both arguments are required on purpose: an absent discriminator would ask about every
 * project on the server at once, which is the ambiguity this record exists to remove. A drop class
 * returned here may be older than the most recent read for the pair — that is the stickiness above,
 * and `at` is what makes it judgeable.
 */
export function getStashReadScope(baseUrl?: string, discriminator?: string): StashReadScope | null {
  if (!baseUrl || !discriminator) return null;
  return stashReadScopeDiagnostics.get(scopeDiagnosticsKey(baseUrl, discriminator)) ?? null;
}

/**
 * The run-audit id for a scoped read that had to drop rows. Declared in `@fusion/core`'s closed
 * `RunAuditMutationType` union; like `memory:stash-read-refused` it sits OUTSIDE the curated
 * delivery-pipeline catalogue and is documented as prose in `docs/run-audit.md`.
 */
export const STASH_READ_SCOPE_MUTATION_TYPE: RunAuditMutationType = "memory:stash-read-scope";

/** Same 15-minute floor as the refusal rows: a chat lane recalls every turn, and `all-own` is silent. */
export const STASH_READ_SCOPE_AUDIT_REFRESH_FLOOR_MS = STASH_READ_REFUSAL_AUDIT_REFRESH_FLOOR_MS;

const lastStashReadScopeAuditAt = new Map<string, number>();

/** Test seam: forget the scope dedupe markers so a suite can observe a fresh emission. */
export function __resetStashReadScopeAuditDedupeForTests(): void {
  lastStashReadScopeAuditAt.clear();
}

/**
 * Record that a scoped read dropped rows: at most one audit row and one warn line per
 * (server, project, class) per window, through the FN-9177 bounded core seam.
 *
 * `all-own` writes NOTHING — the same rule RUFU-994 set for `ok`/`no-match`, because a per-turn
 * recall lane would otherwise write a row every turn and bury the drops under routine traffic.
 *
 * Metadata is counts and one fixed class only. Never a URL (a Stash URL can carry credentials in
 * its userinfo, and the audit store is readable by anything with query access), never a dropped
 * row's `id`/`uri` or text, and deliberately no `endpoint`: the counts are taken after the keyword
 * and semantic branches have been scoped, so an endpoint key would claim an attribution we do not
 * have — and RUFU-1008 must not make the two branches answer differently.
 */
export function reportStashReadScope(
  host: StashReadStoreHost | null | undefined,
  baseUrl: string | undefined,
  identity: StashProjectIdentity,
  scope: StashReadScope,
  opts: { nowMs?: number; refreshFloorMs?: number; log?: RunAuditLogger } = {},
): void {
  if (!baseUrl || scope.outcome === "all-own") return;
  const nowMs = opts.nowMs ?? Date.now();
  const floorMs = opts.refreshFloorMs ?? STASH_READ_SCOPE_AUDIT_REFRESH_FLOOR_MS;
  const log: RunAuditLogger = opts.log ?? stashReadAuditLog;
  try {
    const dedupeKey = scopeDiagnosticsKey(baseUrl, identity.discriminator) + "\u0000" + scope.outcome;
    const lastAt = lastStashReadScopeAuditAt.get(dedupeKey);
    if (lastAt !== undefined && lastAt + floorMs > nowMs) return;
    if (lastStashReadScopeAuditAt.size >= 256) lastStashReadScopeAuditAt.clear();
    lastStashReadScopeAuditAt.set(dedupeKey, nowMs);
    log.warn(
      `[memory] stash read scope outcome=${scope.outcome} own=${scope.ownCount} droppedForeign=${scope.droppedForeignCount} droppedUnidentified=${scope.droppedUnidentifiedCount}`,
    );
    void emitBoundedRunAudit(
      host,
      {
        agentId: STASH_READ_AUDIT_AGENT_ID,
        runId: `${STASH_READ_SCOPE_MUTATION_TYPE}:${scope.outcome}`,
        domain: "database",
        mutationType: STASH_READ_SCOPE_MUTATION_TYPE,
        target: "stash-memory",
        metadata: {
          outcome: scope.outcome,
          matchedCount: scope.matchedCount,
          ownCount: scope.ownCount,
          droppedForeignCount: scope.droppedForeignCount,
          droppedUnidentifiedCount: scope.droppedUnidentifiedCount,
          limit: scope.limit,
        },
      },
      { log },
    );
  } catch {
    // Swallowed on purpose: a diagnostic may never become a lifecycle dependency of the read it
    // describes (FN-9177's contract, restated here for the scope pair).
  }
}

/**
 * The one call a read ENTRY makes after its search has returned: take this root's identity, read the
 * scope record the backend left behind, and report it. It lives here (not in the four entries) so
 * the identity used for the getter is the identity the filter used — two derivations could drift
 * apart and silently stop reporting, the same failure class as RUFU-994's non-resolving key.
 */
export function reportStashReadScopeForRoot(
  host: StashReadStoreHost | null | undefined,
  baseUrl: string | undefined,
  rootDir: string,
  opts: { nowMs?: number; refreshFloorMs?: number; log?: RunAuditLogger } = {},
): void {
  if (!baseUrl) return;
  const identity = stashProjectIdentityFor(rootDir);
  const scope = getStashReadScope(baseUrl, identity.discriminator);
  if (scope) reportStashReadScope(host, baseUrl, identity, scope, opts);
}

/**
 * The transport's rejection message is `Stash returned <status>: <body>` for a non-2xx answer and
 * `Invalid JSON response (<status>): <body>` for an unparseable 2xx. Both shapes are parsed for the
 * STATUS DIGIT ONLY — the body segment is never read into a code, a log line, or an audit row.
 */
function parseStashTransportStatus(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const msg = (err as { message?: unknown }).message;
  if (typeof msg !== "string") return null;
  const m = /^Stash returned (\d{3}):/.exec(msg);
  return m ? Number(m[1]) : null;
}

/** Map a transport rejection onto the closed code set, without retaining any of its text. */
function classifyStashTransportFailure(err: unknown): StashReadOutcomeCode {
  const status = parseStashTransportStatus(err);
  if (status === 401 || status === 403) return "refused-auth";
  if (status === 404 || status === 405 || status === 501 || status === 503) return "refused-capability";
  if (status !== null) return "rejected-request";
  const msg = typeof err === "object" && err !== null ? (err as { message?: unknown }).message : undefined;
  // A 2xx whose body would not parse is a shape problem, not a connectivity one.
  if (typeof msg === "string" && msg.startsWith("Invalid JSON response")) return "malformed";
  return "unreachable";
}

/*
FNXC:StashIsolation 2026-11-19-13:41 (RUFU-1008):
The block that used to sit on `projectDiscriminatorFor` below claimed Stash enforces cross-project
isolation at the SQL level and that the discriminator is "only a provenance/grep-ability tag". That
held for ONE dimension only: Stash scopes by `owner_user_id`, so every project of one operator is a
single read domain and nothing on the server separates them. Measured on the live server
2026-11-19: an unscoped `GET /api/v1/me/sessions/events/search?q=…&limit=…` returned rows whose
`metadata.discriminator` was `dgx_spark-3346c25997` and `gedapp-b4ee5f7bf6` while the asking Fusion
workspace was `Fusion-c5a69b9f0d`, and the route honours no scope parameter at all — adding
`session_folder_id` or a garbage param returned a byte-identical result id list (RUFU-121's inert
param precedent, re-measured).

So the discriminator IS the read-side isolation mechanism, and Fusion is the only party that can
enforce it: writes stamp it (`write()`/`capture()` metadata), reads demand it back
(`classifyStashReadScope`), and a row that cannot prove it belongs to the asking project is never
returned. The server-side read filter this comment used to credit does not exist.
*/
/**
 * Derive a stable, per-project stash session namespace discriminator.
 */
function projectDiscriminatorFor(rootDir: string | undefined): string {
  if (!rootDir) return "fusion-default";
  const projectName = basename(rootDir) || "project";
  const slug = createHash("sha1").update(rootDir).digest("hex").slice(0, 10);
  return `${projectName}-${slug}`;
}

/*
FNXC:StashReadIdentity 2026-11-19-13:41 (RUFU-1008):
ONE function derives the identity a project claims, and both directions of the Stash seam call it:
`write()`/`capture()` stamp it onto the event, `search()`/`read()` verify every returned row against
it. Before this card the two sides each computed it inline in two places, and only the write side
used its result — which is how a read came to return another workspace's notes.

Two values, because the two write paths stamp identity differently:
- `discriminator` — on every event, in `metadata.discriminator` (both `write()` and `capture()`).
- `sessionId` — the top-level `session_id` `write()` supplies for free-text captures.

`sessionFolderId` is deliberately NOT part of this identity: the folder id is resolved against the
Fusion project id (the cache key is `${baseUrl}::${projectId}`) which no read entry holds, and the
probe measured 2026-11-19 that neither search route returns `session_folder_id` on its response
items at all, so a folder match branch could never fire. Carrying an always-absent field would
pretend a third mechanism exists.
*/
export interface StashProjectIdentity {
  /** `metadata.discriminator` value this project's writes stamp. */
  readonly discriminator: string;
  /** Top-level `session_id` value `write()` stamps for free-text captures. */
  readonly sessionId: string;
}

/** The `session_id` a free-text `write()` derives from a root (shared by write and read). */
function stashSessionIdFor(rootDir: string | undefined): string {
  const d = projectDiscriminatorFor(rootDir) || "fusion";
  return `fusion-${d}`.slice(0, 64);
}

/** The identity this project claims against Stash — the ONE source for the write and read sides. */
export function stashProjectIdentityFor(rootDir: string): StashProjectIdentity {
  return {
    discriminator: projectDiscriminatorFor(rootDir),
    sessionId: stashSessionIdFor(rootDir),
  };
}

/*
FNXC:StashReadScope 2026-11-19-13:41 (RUFU-1008):
Stash partitions its store by OWNER, and an operator with several Fusion projects has exactly one
owner. The read route carries no scope filter (measured inert 2026-11-19, RUFU-121's precedent), so
the only place project isolation can be enforced is here, on the way in. This is that place.

The rule is exact equality, never a resemblance: a row is ours when its `metadata.discriminator`
equals this root's discriminator, or its top-level `session_id` equals the id `write()` derives from
this root. No prefix, no substring, no normalisation, no case folding — the same rule that would
admit `fusion-task-VLLM-117` beside `fusion-task-RUFU-1008` is the defect being removed, so the
match is deliberately the narrowest thing that still recognises our own rows.

Anything the rule cannot attribute is dropped, including a row whose `metadata` is present but
carries no discriminator (a Stash-internal curator row, for instance). That is a real cost: recall
from a server that stopped returning `metadata` goes EMPTY, and it stays empty. An empty recall that
is counted and reported (`dropped-unidentified`) is the correct answer; a recall widened to keep rows
whose owner is unknown is the leak this card exists to close.
*/

/** What one scoped read found, as a closed three-value class. */
export const STASH_READ_SCOPE_OUTCOMES = [
  "all-own",
  "dropped-foreign",
  "dropped-unidentified",
] as const;
export type StashReadScopeOutcomeCode = (typeof STASH_READ_SCOPE_OUTCOMES)[number];

/** Result of scoping one server answer to one project. */
export interface StashReadScopeClassification {
  /** Surviving rows, in the server's own order (the server already applied `limit`). */
  kept: StashSearchResultItem[];
  ownCount: number;
  foreignCount: number;
  unidentifiedCount: number;
  /**
   * `dropped-foreign` wins when both classes are present: an attributable row belonging to another
   * project is the security-relevant fact, and an operator reading one number must read the worse
   * one, not the incidental one.
   */
  outcome: StashReadScopeOutcomeCode;
}

/** True when a response row carries exactly the identity this project writes with. */
function stashRowIsOwn(item: StashSearchResultItem, identity: StashProjectIdentity): boolean {
  const meta = item.metadata;
  if (meta && typeof meta === "object") {
    const disc = (meta as { discriminator?: unknown }).discriminator;
    if (typeof disc === "string" && disc === identity.discriminator) return true;
  }
  return typeof item.session_id === "string" && item.session_id === identity.sessionId;
}

/** True when the row names a project identity and it is not ours (as opposed to naming none). */
function stashRowIsForeign(item: StashSearchResultItem, identity: StashProjectIdentity): boolean {
  const meta = item.metadata;
  if (!meta || typeof meta !== "object") return false;
  const disc = (meta as { discriminator?: unknown }).discriminator;
  return typeof disc === "string" && disc !== identity.discriminator;
}

/**
 * Split one Stash answer into this project's rows and the rows that must not reach a prompt. Pure:
 * no I/O, no mutation, and the returned order is the server's order unchanged.
 */
export function classifyStashReadScope(
  items: readonly StashSearchResultItem[],
  identity: StashProjectIdentity,
): StashReadScopeClassification {
  const kept: StashSearchResultItem[] = [];
  let foreignCount = 0;
  let unidentifiedCount = 0;
  for (const item of items) {
    if (stashRowIsOwn(item, identity)) {
      kept.push(item);
      continue;
    }
    if (stashRowIsForeign(item, identity)) foreignCount += 1;
    else unidentifiedCount += 1;
  }
  const outcome: StashReadScopeOutcomeCode =
    foreignCount > 0 ? "dropped-foreign" : unidentifiedCount > 0 ? "dropped-unidentified" : "all-own";
  return { kept, ownCount: kept.length, foreignCount, unidentifiedCount, outcome };
}

/*
FNXC:StashReadWindow 2026-11-21-12:36 (RUFU-1146):
RUFU-1008 made every Stash read prove project identity on every returned row, and the price was the
page size: the server applies `limit` over the WHOLE owner-wide store (it has no project filter to
honour), and the client drops what is not ours afterwards, so `limit` stopped being the number of
rows a caller received. Measured on the live server over every scoped read after RUFU-1008 landed
(`project.run_audit_events`, `memory:stash-read-scope`): 116 reads, 839 rows answered, 261 kept (31
percent), 33 reads (28 percent) returned an EMPTY page, and ZERO reads filled the requested limit.
"The project's memory is empty" was mostly this, not an empty store.

The repair is to buy the window before spending it: ask for a wider window, scope, and only then
trim to what the caller asked for. Two bounds make that safe against the server rather than merely
optimistic:
- The window NEVER exceeds what the route validates (`le=200` keyword, `le=100` semantic, verified in
  `backend/routers/memory.py`). Asking for more would trade a short page for a 422, which is a worse
  read, not a wider one.
- A server that refuses the wide window (`rejected-request`) is answered again with the exact
  requested limit, so shipping the wider window can never produce a worse answer than the pre-fix
  shape. Same reasoning as RUFU-126's "the vector path can never make recall worse than the keyword
  baseline".

At most ONE widening request per read, so a read is two HTTP calls and never a paging loop.
*/

/** Stash `/me/sessions/events/search` validates `limit` at `le=200`; above it the route 422s. */
export const STASH_KEYWORD_SEARCH_SERVER_MAX_LIMIT = 200;

/** Stash `/me/sessions/events/semantic-search` validates `limit` at `le=100`. */
export const STASH_SEMANTIC_SEARCH_SERVER_MAX_LIMIT = 100;

/**
 * How much wider than the page to ask for. From the measurement above the shared-owner own-row rate
 * is 0.31, so a 6x window fills a 10-row page from a store shared by 25 projects without a second
 * call in the common case, and the widening below is what covers the queries the project barely
 * matches at all.
 */
export const STASH_READ_WINDOW_FACTOR = 6;

/**
 * The window to ask the server for so that scoping afterwards can still fill `requested`.
 * Clamped to `serverMax` (the route's own validation ceiling) and never below `requested`.
 */
export function stashReadFetchWindow(requested: number, serverMax: number): number {
  const floor = Math.max(1, requested);
  return Math.min(serverMax, Math.max(floor, floor * STASH_READ_WINDOW_FACTOR));
}

/**
 * Merge a narrow and a wide answer of the SAME query into one list with no row twice, in the
 * server's order (the wide answer is a superset of the narrow one; the merge is defensive, not
 * trusting). A row without any usable identity is kept rather than guessed away, because dropping a
 * row for a missing `id` would reintroduce the loss this merge exists to remove.
 */
export function mergeStashRowsById(
  narrow: readonly StashSearchResultItem[],
  wide: readonly StashSearchResultItem[],
): StashSearchResultItem[] {
  const merged: StashSearchResultItem[] = [];
  const seen = new Set<string>();
  for (const item of [...narrow, ...wide]) {
    const key = stashRowIdentityKey(item);
    if (key === null) {
      merged.push(item);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

/** Dedup key for one answer row: its event id, else the (session, content) tuple it arrived with. */
function stashRowIdentityKey(item: StashSearchResultItem): string | null {
  if (typeof item.id === "string" && item.id !== "") return `i:${item.id}`;
  if (typeof item.id === "number") return `i:${item.id}`;
  const session = typeof item.session_id === "string" ? item.session_id : null;
  const content = typeof item.content === "string" ? item.content : null;
  if (session === null && content === null) return null;
  return `sc:${session ?? ""}\u0000${content ?? ""}`;
}

/**
 * FNXC:RUFU121QueryNormalization 2026-08-18-19:53:
 * RUFU-121: normalize a raw recall query to a
 * Postgres `websearch_to_tsquery('english')`-safe form. Stash's search
 * pipeline runs the tsquery over the full event text; un-normalized input
 * risks parser errors (unbalanced quotes, exotic characters) or silently
 * wrong tokenization.
 *
 * Algorithm (deterministic, pure):
 * 1. Strip non-ASCII (keep \x20–\x7E only), collapse whitespace runs to one
 *    space, trim.
 * 2. If ANY token is exactly `OR` (case-sensitive): keep ALL word tokens
 *    plus the `OR` tokens in order (pure-punctuation tokens dropped).
 *    Otherwise keep ONLY the first word token (websearch's implicit AND
 *    would over-narrow multi-token user queries).
 * 3. Strip all non-`[A-Za-z0-9]` from each kept token; drop tokens that
 *    become empty.
 * 4. Join with single spaces.
 * 5. Cap at 100 characters on a token boundary (drop trailing tokens;
 *    never truncate mid-token).
 *
 * null/undefined/empty/whitespace-only → "" (caller decides the
 * fail-closed behavior).
 */
export function normalizeStashSearchQuery(raw: string | null | undefined): string {
  if (raw == null) return "";
  const ascii = raw.replace(/[^\x20-\x7E]/g, "");
  const collapsed = ascii.replace(/ +/g, " ").trim();
  if (collapsed === "") return "";
  const tokens = collapsed.split(" ");
  // Step 2: OR-preserving mode keeps word tokens ("OR" is itself a word
  // token); default mode keeps only the first word token.
  const kept = tokens.includes("OR")
    ? tokens.filter((t) => /[A-Za-z0-9]/.test(t))
    : tokens.filter((t) => /[A-Za-z0-9]/.test(t)).slice(0, 1);
  const cleaned = kept.map((t) => t.replace(/[^A-Za-z0-9]/g, "")).filter((t) => t.length > 0);
  // Step 5: 100-char cap on a token boundary — never mid-token.
  let joined = "";
  for (const t of cleaned) {
    const candidate = joined === "" ? t : `${joined} ${t}`;
    if (candidate.length > 100) break;
    joined = candidate;
  }
  return joined;
}

// ── Keyword relevance scoring (RUFU-133) ─────────────────────────────

/**
 * FNXC:RUFU133StashScore 2026-08-25-20:17:
 * RUFU-133: parse a rank/score value arriving untyped (through the
 * response cast) into a usable finite number, or null. Mirrors the RUFU-126
 * vector path's rank-parse pattern: a finite number, OR a non-empty (after
 * trim) string whose Number(...) is finite; null for everything else (NaN,
 * null, undefined, objects, non-numeric strings, empty/whitespace strings).
 */
function parseUsableNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * FNXC:RUFU133StashScore 2026-08-25-20:17:
 * RUFU-133: per-event relevance score for ONE keyword hit — the three-tier
 * comparable 0..1 mapping (contract: docs/memory-plugin-contract.md
 * §3.3.2, D5 companion to RUFU-126):
 * - Tier 1: `score` usable → clamped to [0,1]. Per-item precedence: a
 *   server score beats rank when both are present.
 * - Tier 2: else `rank` usable AND maxRank > 0 → rank / maxRank clamped to
 *   [0,1] (top hit = exactly 1.0). ts_rank is only meaningful relative to
 *   the result set, so `maxRank` is the max usable rank across ALL result
 *   items (computed by the caller before the map).
 * - Tier 3: else the pre-existing positional scores (2.0 first hit, 1.0
 *   rest) — the undeployed-server fallback; a server supplying neither
 *   rank nor score behaves byte-identically to the pre-RUFU-133 mapping.
 * maxRank == 0 (all ranks zero or missing) forces tier 3 — no
 * divide-by-zero. WHY: one 0..1 scale shared with the RUFU-126 vector
 * cosine so the RUFU-120 client-side min-score filter can rank weak
 * keyword hits against weak vector hits with a single threshold.
 * Pure: same inputs → same output; no I/O.
 */
export function stashRelevanceScore(
  item: { rank?: unknown; score?: unknown },
  idx: number,
  maxRank: number,
): number {
  const score = parseUsableNumber(item.score);
  if (score !== null) return Math.min(1, Math.max(0, score));
  const rank = parseUsableNumber(item.rank);
  if (rank !== null && maxRank > 0) return Math.min(1, Math.max(0, rank / maxRank));
  return 2 - Math.min(idx, 1);
}

// ── Stash Memory Backend ─────────────────────────────────────────────

/**
 * Memory backend that delegates read/search/write to the Stash REST API.
 *
 * Capabilities:
 * - `read()`: Searches stash for the current project's most relevant memories
 *   (broad empty query) and returns them as markdown. Fails CLOSED to
 *   {content:"", exists:false}.
 * - `search()`: GET /api/v1/me/sessions/events/search → MemorySearchResult[].
 * - `write()`: POST /api/v1/me/sessions/events/batch (best-effort; never throws).
 * - `read()/get()/exists()`: fail closed on any error (stash down, auth
 *   failure, parse error) — NEVER blocks a run.
 * - `capture()/endSession()`: same write path, best-effort and non-blocking.
 */
export class StashMemoryBackend implements MemoryBackend {
  readonly type = "stash";
  readonly name = "Stash (personal knowledge-base)";
  readonly capabilities: MemoryBackendCapabilities = {
    readable: true,
    writable: true,
    supportsAtomicWrite: false,
    hasConflictResolution: true,
    persistent: true,
  };

  private readonly baseUrl: string;
  private readonly apiKey: string;

  /*
  FNXC:Rufu126VectorSearch 2026-08-19-10:50:
  RUFU-126 (D3): opt-in vector (semantic) search, default OFF. Enabled by the
  per-project `stashVectorSearch` setting (settings-schema.ts) threaded through
  resolveMemoryBackend. Default-off = zero behavior change until the operator
  enables it (this is a prototype); rejected alternative was automatic
  capability detection (changes default behavior + per-process 404 round-trip
  cost against unpatched servers).
  */
  private readonly vectorSearch: boolean;

  /**
   * FNXC:RUFU121TransportSeam 2026-08-18-19:53:
   * RUFU-121: injectable clock (default Date.now) for the session-folder
   * cache TTL and injectable HTTP transport seam (default: real node:http
   * JSON transport). Tests inject a fake clock + recorder http — no network.
   */
  private readonly now: () => number;
  private readonly client: StashHttpClient;

  constructor(options?: {
    baseUrl?: string;
    apiKey?: string;
    /** RUFU-121: injectable clock for the session-folder cache TTL. */
    now?: () => number;
    /** RUFU-121: injectable HTTP transport seam (recorder fake in tests). */
    httpClient?: StashHttpClient;
    /** RUFU-126: opt-in vector (semantic) search path (default false). */
    vectorSearch?: boolean;
  }) {
    this.baseUrl = (options?.baseUrl ?? DEFAULT_STASH_URL).replace(/\/+$/, "");
    this.apiKey = options?.apiKey ?? "";
    this.vectorSearch = options?.vectorSearch === true;
    this.now = options?.now ?? (() => Date.now());
    this.client =
      options?.httpClient ??
      ((path, method, payload) => stashHttpJsonRequest(this.baseUrl, this.apiKey, path, method, payload));
  }

  /** Provenance tag stamped on every write — and the identity every read verifies (RUFU-1008). */
  private discriminatorFor(rootDir: string): string {
    return projectDiscriminatorFor(rootDir);
  }

  /**
   * Stable per-project session id for free-text `write()` captures (which have
   * no caller-supplied session id). Stash requires a non-empty top-level
   * session_id; deriving one from the project discriminator keeps write()
   * idempotent per project without colliding across projects.
   */
  private sessionIdFor(rootDir: string): string {
    // RUFU-1008: delegates to the ONE identity derivation the read side verifies against, so the two
    // sides cannot drift (`stashProjectIdentityFor` is that function's public face).
    return stashSessionIdFor(rootDir);
  }

  /**
   * FNXC:RUFU121FolderNaming 2026-08-18-19:53:
   * RUFU-121: resolve (get-or-create) the per-project Stash session folder.
   * Display name `Fusion — <project>` (U+2014 em dash; `Fusion` alone when
   * the name is unavailable); stable machine identity `external_key`
   * `fusion-<projectId>` so project renames never break resolution.
   * Best-effort: any failure or absent id → undefined (capture proceeds
   * folder-less); failures are never cached.
   */
  private async resolveProjectFolderId(projectId: string, projectName?: string): Promise<string | undefined> {
    const cacheKey = `${this.baseUrl}::${projectId}`;
    const now = this.now();
    const cached = stashFolderCache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.folderId;
    // FNXC:RUFU121FolderNaming 2026-08-18-19:53: U+2014 em dash between "Fusion" and the project name.
    const trimmedName = projectName?.trim();
    const name = trimmedName ? `Fusion \u2014 ${trimmedName}` : "Fusion";
    try {
      const resp = await this.client("/api/v1/me/session-folders/get-or-create", "POST", {
        name,
        external_key: `fusion-${projectId}`,
      });
      const rawId = (resp as { id?: unknown } | null)?.id;
      const folderId = typeof rawId === "string" ? rawId : typeof rawId === "number" ? String(rawId) : undefined;
      if (!folderId) return undefined;
      // FNXC:RUFU121FolderCache 2026-08-18-19:53: successes only — never cache failures.
      stashFolderCache.set(cacheKey, { folderId, expiresAt: now + STASH_FOLDER_CACHE_TTL_MS });
      return folderId;
    } catch {
      return undefined;
    }
  }

  // ── read ───────────────────────────────────────────────────────────

  /**
   * Read the most relevant stash memories for a project as markdown.
   * Sends a broad empty query. Fails CLOSED: any error -> {content:"",exists:false}.
   */
  async read(rootDir: string): Promise<MemoryReadResult> {
    try {
      const results = await this.search(rootDir, { query: "", limit: 10 });
      if (results.length === 0) {
        // RUFU-994: `read()` reports its own endpoint so a broad-recall miss is attributed to
        // `read`, not to whichever keyword URL the search happened to use.
        this.noteReadOutcome("read", "no-match", 0);
        return { content: "", exists: false, backend: this.type };
      }
      this.noteReadOutcome("read", "ok", results.length);
      const header = `\`\`\`\n[Stash Memory] ${results.length} memories recalled\n\`\`\`\n\n`;
      const body = results
        .map((r) => `### ${r.path}\n${r.snippet}`)
        .join("\n\n---\n\n");
      return { content: header + body, exists: true, backend: this.type };
    } catch (err) {
      // FNXC:StashFailClosed 2026-08-05-16:06:
      // Stash down / auth / parse failure must never throw out of read() — the
      // seam-level getProjectMemory wrapper and buildProactiveMemoryCueBlock
      // depend on empty reads meaning "no memory available", not "backend error".
      // RUFU-994 keeps that contract and records WHY, so "not allowed to look" and
      // "nothing stored" stop being the same answer.
      this.noteReadOutcome("read", this.readFailureCode(err), 0);
      return { content: "", exists: false, backend: this.type };
    }
  }

  // ── write ──────────────────────────────────────────────────────────

  /**
   * Capture a memory event via POST /api/v1/me/sessions/events/batch.
   * Best-effort: never throws. On any failure returns {success:false}.
   *
   * FNXC:RUFU121WriteIdentity 2026-08-18-19:53:
   * RUFU-121: optional trailing identity meta. When it carries a projectId,
   * the event is classified into the per-project session folder
   * (session_folder_id) and metadata gains project/project_name keys — same
   * fail-open contract as capture().
   */
  async write(rootDir: string, content: string, meta?: MemoryWriteIdentity): Promise<MemoryWriteResult> {
    const projectId = meta?.projectId ?? null;
    const projectName = meta?.projectName ?? null;
    // FNXC:RUFU121FolderAssignment 2026-08-18-19:53: best-effort folder
    // resolution — failure/absence proceeds folder-less (backward compat).
    const sessionFolderId = projectId ? await this.resolveProjectFolderId(projectId, projectName ?? undefined) : undefined;
    try {
      await this.batchUpload(this.discriminatorFor(rootDir), [
        {
          event_type: "memory",
          content: content.substring(0, 4000),
          // FNXC:StashEventShape 2026-08-07-10:39: mirror the capture() fix —
          // stash requires top-level agent_name + session_id, so write() must
          // supply stable defaults rather than letting batchUpload fall back.
          agent_name: "fusion",
          session_id: this.sessionIdFor(rootDir),
          ...(sessionFolderId ? { session_folder_id: sessionFolderId } : {}),
          // FNXC:RUFU121MetadataEnrichment 2026-08-18-19:53:
          // RUFU-121 identity enrichment — keys appear only when the value is
          // present (never `undefined` spam).
          metadata: {
            discriminator: this.discriminatorFor(rootDir),
            ...(projectId ? { project: projectId } : {}),
            ...(projectName ? { project_name: projectName } : {}),
          },
        },
      ]);
      return { success: true, backend: this.type };
    } catch {
      return { success: false, backend: this.type };
    }
  }

  // ── get ────────────────────────────────────────────────────────────

  /**
   * Not file-path oriented — fails closed to an empty result without throwing.
   */
  async get(_rootDir: string, options: MemoryGetOptions): Promise<MemoryGetResult> {
    return {
      path: options.path,
      content: "",
      startLine: 1,
      endLine: 1,
      totalLines: 0,
      backend: this.type,
    };
  }

  // ── search ─────────────────────────────────────────────────────────

  /**
   * Search stash events via GET /api/v1/me/sessions/events/search.
   * Maps each result to a MemorySearchResult. Fails CLOSED to [] on any error.
   *
   * FNXC:StashReadScope 2026-11-19-13:41 (RUFU-1008): every row the server answers with is verified
   * against this root's identity before it is returned — see `scopeItemsToProject()`. A row that
   * cannot prove it was written by this project is dropped and counted, so a Stash account shared by
   * several Fusion projects can no longer deliver one project's notes into another's prompt.
   *
   * FNXC:Rufu126VectorSearch 2026-08-19-10:50:
   * RUFU-126: vector-first / fallback invariant (decisions D1–D5, see
   * docs/research/stash-vector-search-evaluation.md):
   * - D1: the vector path is a SEPARATE endpoint (GET
   *   /api/v1/me/sessions/events/semantic-search), not a mode=vector param —
   *   FastAPI silently ignores undeclared params, so an unpatched server
   *   would return keyword results mislabeled as vector; a new path 404s
   *   cleanly and matches Stash's /me/pages/semantic-search precedent.
   * - D2: applies only to MULTI-word queries (≥2 whitespace-separated tokens
   *   in the trimmed raw query); single-word queries stay keyword-only
   *   (exact-token FTS is the best single-token baseline).
   * - Fallback (load-bearing): on ANY vector failure — network error/timeout,
   *   non-2xx, malformed body, or an EMPTY vector result list — control falls
   *   through to the RUFU-121 keyword path BYTE-IDENTICAL below (normalized
   *   q, legacy empty-query URL, limit cap, fail-closed []). The vector path
   *   can therefore never make recall worse than the keyword baseline.
   * - D3: negative-capability cache (per-process, baseUrl-keyed, TTL 1h)
   *   suppresses the vector attempt after definitive 404/405/501/503 —
   *   never after 422/500 or network errors.
   * - D5: vector score = response `rank` (= cosine similarity, 0..1); the
   *   keyword path no longer keeps positional 2/1 when the server supplies
   *   rank/score — see FNXC:RUFU133StashScore (positional is the residual
   *   fallback for undeployed servers only). Missing/non-finite rank → 1.0.
   */
  async search(rootDir: string, options: MemorySearchOptions): Promise<MemorySearchResult[]> {
    const req = options.query || "";
    const limit = Math.max(1, Math.min(options.limit ?? 5, 20));
    // ── RUFU-126 vector-first branch (D1/D2/D3) ──
    // Multi-word raw queries only; suppressed while a definitive
    // no-vector response is cached for this baseUrl. null → fall through;
    // the keyword path below is byte-identical (RUFU-121).
    const rawTrimmed = req.trim();
    if (
      this.vectorSearch &&
      rawTrimmed.length > 0 &&
      rawTrimmed.split(/\s+/).length >= 2 &&
      this.vectorSearchAvailable()
    ) {
      const vectorHits = await this.vectorSearchHits(rawTrimmed, limit, rootDir);
      if (vectorHits) return vectorHits;
    }
    /*
    FNXC:RUFU121TopicRemoval 2026-08-18-19:53:
    RUFU-121: removes the inert `&topic=` query param. Stash's search_events
    route (backend/routers/memory.py) accepts only q+limit and has no topic
    filter (verified 2026-08-18 against /home/schindler/git/stash); the param
    was always dropped server-side. MemorySearchOptions.topic stays for the
    other backends. Stash topic-like recall scoping uses the structured
    queryStashEvents() filters.

    URL contract (load-bearing):
    - empty/whitespace raw query → LEGACY URL preserved BYTE-IDENTICAL
      (raw, as encoded today); read()/exists() broad recall relies on the
      current fail-closed path for this shape.
    - non-empty raw query → `q=` + normalizeStashSearchQuery(raw) (Postgres
      websearch_to_tsquery('english')-safe); a query that normalizes to ""
      returns [] with NO HTTP call (Stash 422s empty q).
    */
    let q = req;
    if (req.trim().length > 0) {
      const normalized = normalizeStashSearchQuery(req);
      // RUFU-994: this state sends no request at all, so it records `no-match` — the same
      // "nothing found" answer a 2xx-with-zero-results gives, and never a refusal code.
      if (normalized === "") {
        this.noteReadOutcome("keyword-search", "no-match", 0);
        return [];
      }
      q = normalized;
    }
    /*
    FNXC:StashReadWindow 2026-11-21-12:36 (RUFU-1146):
    The window is bought before it is spent (see the block at `stashReadFetchWindow`). The legacy
    empty-query shape is deliberately NOT widened: its URL is a documented byte-identical contract,
    `read()`/`exists()` are reachability/broad-recall probes of it, and the shape is the one the
    deployed route refuses on `q` length anyway, so a wider window would change a contract without
    buying a single row.
    */
    const isLegacyEmptyQuery = req.trim().length === 0;
    const fetchWindow = isLegacyEmptyQuery
      ? limit
      : stashReadFetchWindow(limit, STASH_KEYWORD_SEARCH_SERVER_MAX_LIMIT);
    try {
      /*
      FNXC:StashReadWindow 2026-11-21-12:36 (RUFU-1146):
      A server that refuses the WIDE window as a REQUEST (400/422 validation of `limit`, i.e. a
      deployed route narrower than the one this window was sized against) still answers the
      exact-limit one, and the pre-fix shape is exactly that request. Only those two statuses
      downgrade the window: a 5xx, a timeout, or an auth refusal is not a window problem, and
      silently re-asking those would be a retry this card never promised.
      */
      let items: StashSearchResultItem[];
      try {
        items = await this.fetchKeywordRows(q, fetchWindow);
      } catch (err) {
        const refusedStatus = parseStashTransportStatus(err);
        if (fetchWindow === limit || (refusedStatus !== 400 && refusedStatus !== 422)) throw err;
        this.noteReadOutcome("keyword-search", "rejected-request", 0);
        items = await this.fetchKeywordRows(q, limit);
      }
      if (
        fetchWindow > limit
        // Only a window the server FILLED can hide more rows: an answer shorter than the window is
        // the store being exhausted for this query, which no wider request can change.
        && items.length >= fetchWindow
        && classifyStashReadScope(items, stashProjectIdentityFor(rootDir)).kept.length < limit
        && fetchWindow < STASH_KEYWORD_SEARCH_SERVER_MAX_LIMIT
      ) {
        /*
        FNXC:StashReadWindow 2026-11-21-12:36 (RUFU-1146):
        The page came back shorter than what was asked for while the window still had headroom AND the
        server filled the window we asked for, so the shortness is the owner-wide store, not an empty
        project. Widen ONCE to the route's own ceiling. A failing widening is swallowed: the rows
        already in hand are a strictly better answer than no answer, and one refused request may not
        discard them.
        */
        try {
          items = mergeStashRowsById(
            items,
            await this.fetchKeywordRows(q, STASH_KEYWORD_SEARCH_SERVER_MAX_LIMIT),
          );
        } catch {
          // Keep the narrow window's answer; the scoped record below still reports what was measured.
        }
      }
      // One scoped read, one record: `matchedCount` is the whole window the server answered.
      const scoped = this.scopeItemsToProject(items, rootDir, limit);
      /*
      FNXC:StashResultHygiene 2026-11-21-12:56 (RUFU-1088):
      Hygiene runs on the FAR side of scoping and BEFORE the slice. Scope first, because a hygiene pass
      over another project's rows would spend the page on rows we are forbidden to read. Slice last, and
      inside the pass, because the per-session cap has to choose across sessions: trimming first is what
      let one session (`fusion-task-SANE-367`) occupy 9 of 10 slots while six other sessions that were in
      the answer contributed nothing. A page shortened by this is the honest answer, recorded as
      `no-match` when it empties and never padded back up.
      */
      const filtered = hygieneStashItems(scoped, limit);
      // FNXC:RUFU133StashScore 2026-08-25-20:17:
      // RUFU-133: maxRank = the max usable rank across ALL surviving items
      // (0 when none), computed BEFORE the map — ts_rank is only meaningful
      // relative to the whole result set, and maxRank == 0 forces the
      // positional fallback (no divide-by-zero). See stashRelevanceScore for
      // the three-tier 0..1 mapping (D5 companion; contract in
      // docs/memory-plugin-contract.md §3.3.2).
      const maxRank = filtered.reduce((max, it) => {
        const r = parseUsableNumber(it.rank);
        return r !== null && r > max ? r : max;
      }, 0);
      /*
      FNXC:StashResultHygiene 2026-11-21-12:56 (RUFU-1088):
      The number a row carries is checked for honesty before it is delivered. `stashRelevanceScore` runs
      EXACTLY as RUFU-133 specified — unchanged arithmetic, unchanged magnitudes — and `labelStashRanking`
      then looks at the finished page: if every row on it carries the same number, that number is the
      constant our deployed Stash image sends (measured: 10 rows, `0.18558138608932495` identical to the
      last digit) and it is labelled for what it is rather than presented as relevance. A non-degenerate
      page gets no field at all, so existing consumers see byte-identical result objects.
      */
      const ranked = labelStashRanking(
        filtered,
        filtered.map((it, idx) => stashRelevanceScore(it, idx, maxRank)),
      );
      // RUFU-994: `no-match` (an answered query with nothing found) is recorded as its own outcome.
      // RUFU-1088: the count is taken from the FINAL page, so `resultCount` is what a caller received —
      // a page hygiene emptied records `no-match` rather than the raw hit count.
      this.noteReadOutcome("keyword-search", filtered.length > 0 ? "ok" : "no-match", filtered.length);
      return filtered.map((it, idx) => ({
        path: it.session_id ? `stash://session/${it.session_id}` : `stash://event/${it.id ?? idx}`,
        lineStart: 1,
        lineEnd: 1,
        snippet: (it.snippet ?? it.content ?? "").substring(0, 500),
        score: ranked[idx]!.score,
        backend: this.type,
        ...(ranked[idx]!.rankingSource ? { rankingSource: ranked[idx]!.rankingSource } : {}),
      }));
    } catch (err) {
      // FNXC:StashFailClosed 2026-08-05-16:06:
      // stash down -> [] -> LCM cue "" -> run proceeds. Never throws.
      // RUFU-994: the swallowed cause is now recorded (see STASH_READ_OUTCOME_CODES).
      this.noteReadOutcome("keyword-search", this.readFailureCode(err), 0);
      return [];
    }
  }

  /*
  FNXC:StashReadWindow 2026-11-21-12:36 (RUFU-1146):
  One keyword request over the documented URL contract (`q` = the already-normalized query, `limit` =
  the window). Throws like the transport seam it wraps: the CALLER decides whether a refusal is
  fail-closed or degradable, because the two differ by window, not by error class.
  */
  private async fetchKeywordRows(q: string, windowLimit: number): Promise<StashSearchResultItem[]> {
    const resp = await this.httpRequest<StashSearchResponse>(
      `/api/v1/me/sessions/events/search?q=${encodeURIComponent(q)}&limit=${windowLimit}`,
      "GET",
    );
    const items = resp.results ?? resp.events ?? [];
    return items.filter((it): it is StashSearchResultItem => Boolean(it) && typeof it === "object");
  }

  /**
   * RUFU-126 (D3): false while a definitive no-vector OR refused-auth response is cached for this
   * baseUrl and its TTL has not expired. Suppression covers the semantic ATTEMPT only; the keyword
   * path is never gated here.
   */
  private vectorSearchAvailable(): boolean {
    const entry = stashVectorNegativeCache.get(this.baseUrl);
    return !entry || entry.expiresAt <= this.now();
  }

  /*
  FNXC:Rufu126VectorSearch 2026-08-19-10:50:
  RUFU-126 (D1): one semantic-search attempt. Returns mapped hits on 2xx with
  a non-empty results array; null on ANY other outcome (network error/timeout,
  non-2xx, malformed body, empty list) so the caller falls through to the
  keyword path. Definitive no-vector statuses {404, 405, 501, 503} and — since
  RUFU-994 — auth refusals {401, 403} are negatively cached per baseUrl (TTL 1h);
  422/500 and network errors are never cached (transient/malformed — retry next
  call). The raw trimmed query is sent UN-normalized (the embedder tokenizes on its
  own), capped at 200 chars.
  */
  private async vectorSearchHits(
    rawQuery: string,
    limit: number,
    rootDir: string,
  ): Promise<MemorySearchResult[] | null> {
    const q = rawQuery.slice(0, 200);
    // FNXC:StashReadWindow 2026-11-21-12:36 (RUFU-1146): same window-before-scope repair as the
    // keyword route, bounded by THIS route's own validated ceiling. No widening ladder here: an
    // answer the scoping empties already falls through to the keyword path below, which widens.
    const windowLimit = stashReadFetchWindow(limit, STASH_SEMANTIC_SEARCH_SERVER_MAX_LIMIT);
    try {
      const resp = await this.httpRequest<StashSearchResponse>(
        `/api/v1/me/sessions/events/semantic-search?q=${encodeURIComponent(q)}&limit=${windowLimit}`,
        "GET",
      );
      const items = resp?.results ?? resp?.events;
      if (!Array.isArray(items) || items.length === 0) {
        // Empty list → keyword fallback. RUFU-994: the vector lane records ITS OWN endpoint,
        // so a semantic-search refusal is never attributed to the keyword route.
        this.noteReadOutcome("semantic-search", Array.isArray(items) ? "no-match" : "malformed", 0);
        return null;
      }
      const scoped = this.scopeItemsToProject(
        items.filter((it): it is StashSearchResultItem => Boolean(it) && typeof it === "object"),
        rootDir,
        limit,
      );
      // FNXC:StashResultHygiene 2026-11-21-12:56 (RUFU-1088): same hygiene pass as the keyword route,
      // with THIS lane's text order (`content` first) so a row is judged on the text it would deliver.
      const own = hygieneStashItems(
        scoped,
        limit,
        (it) => (it.content ?? it.snippet ?? "").substring(0, 500),
      );
      const hits = own
        .map((it, idx) => {
          // D5: vector rank = similarity (0..1); missing/null/non-finite → 1.0.
          // FNXC:RUFU133StashScore 2026-08-25-20:17: typed `unknown` (the
          // runtime value arrives untyped through the response cast, same as
          // the keyword path) — behavior identical to before.
          const rawRank: unknown = it.rank;
          const rank =
            typeof rawRank === "number"
              ? rawRank
              : typeof rawRank === "string" && rawRank.trim() !== ""
                ? Number(rawRank)
                : NaN;
          return { item: it, idx, rawScore: Number.isFinite(rank) ? rank : 1.0 };
        });
      /*
      FNXC:StashResultHygiene 2026-11-21-12:56 (RUFU-1088):
      The cosine similarity is a real signal when it VARIES. When every row on the page carries the same
      number — which is what "missing rank → 1.0" produces for a whole page, and what a server returning
      a constant similarity produces too — the page has no ordering information in it, and saying so is
      cheaper than letting a consumer rank on it.
      */
      const ranked = labelStashRanking(own, hits.map((h) => h.rawScore));
      const rows = hits.map((h, i) => ({
        path: h.item.session_id
          ? `stash://session/${h.item.session_id}`
          : `stash://event/${h.item.id ?? h.idx}`,
        lineStart: 1,
        lineEnd: 1,
        snippet: (h.item.content ?? h.item.snippet ?? "").substring(0, 500),
        score: ranked[i]!.score,
        backend: this.type,
        ...(ranked[i]!.rankingSource ? { rankingSource: ranked[i]!.rankingSource } : {}),
      })) as MemorySearchResult[];
      // RUFU-994: an answered semantic hit records the semantic endpoint as healthy. RUFU-1088: the
      // count is the delivered page, after hygiene.
      this.noteReadOutcome("semantic-search", rows.length > 0 ? "ok" : "no-match", rows.length);
      return rows.length > 0 ? rows : null;
    } catch (err) {
      this.noteReadOutcome("semantic-search", this.readFailureCode(err), 0);
      const status = this.stashErrorStatus(err);
      // An unresolved key arrives here as the server's 401 too, so this one set covers both halves;
      // the recorded CODE above stays `key-unresolved`, which is what keeps our own misconfiguration
      // distinguishable from a refusal of a key Stash actually received (RUFU-994 Step 5).
      if (status !== null && STASH_VECTOR_NEGATIVE_STATUSES.has(status)) {
        stashVectorNegativeCache.set(this.baseUrl, {
          expiresAt: this.now() + STASH_VECTOR_NEGATIVE_CACHE_TTL_MS,
        });
      }
      return null;
    }
  }

  /**
   * RUFU-126: parse the `Stash returned <code>: ...` status out of the
   * transport seam's rejection message; null for any other error shape.
   */
  private stashErrorStatus(err: unknown): number | null {
    return parseStashTransportStatus(err);
  }

  /*
  FNXC:StashReadAuth 2026-11-12-19:34 (RUFU-994):
  One record per read attempt, written at every site that used to swallow a refusal. The record
  NEVER changes what the caller receives — `search()` still returns [] and `read()` still returns
  empty content — it only answers the question those catches made unanswerable: was this empty
  because nothing is stored, or because the request was refused?

  A backend holding no credential records `key-unresolved` rather than `refused-auth` even though
  the server's answer is the same 401: the cause is our configuration, not Stash rejecting a key it
  received, and collapsing the two would send the operator to the wrong knob.
  */
  private noteReadOutcome(
    endpoint: StashReadEndpoint,
    code: StashReadOutcomeCode,
    resultCount: number,
  ): void {
    recordStashReadOutcome(
      this.baseUrl,
      { code, endpoint, keyResolved: this.apiKey !== "", resultCount },
      this.now(),
    );
  }

  /*
  FNXC:StashReadScope 2026-11-19-13:41 (RUFU-1008):
  THE read-side choke point. Both search branches pass their raw server rows through here and nothing
  reaches a caller without it: the keyword branch of `search()`, and `vectorSearchHits()` — whose
  hits used to `return` straight out of `search()` and would otherwise have bypassed any filter placed
  on the keyword route (a vector-first bypass is exactly why one shared call, not one shared line,
  is the invariant). `read()` needs no separate filter because it calls `search()`.

  What it does NOT do: send a scope parameter. Measured 2026-11-19 against the live server, the route
  ignores undeclared params (RUFU-121's precedent re-confirmed), so a param would advertise an
  enforcement that does not exist; the refusal here is explicit and counted instead.

  Every scoped read reaches this record, `all-own` included, because the operator surfaces must
  distinguish "this project has nothing" from "rows arrived and were dropped" — an absent record is
  the first question they would have to ask. `all-own` never displaces an existing drop class (see
  `recordStashReadScope`): a two-lane reader reports once, after its second search, and a clean second
  search must not erase what the first one returned.
  */
  private scopeItemsToProject(
    items: StashSearchResultItem[],
    rootDir: string,
    limit: number,
  ): StashSearchResultItem[] {
    const identity = stashProjectIdentityFor(rootDir);
    const classification = classifyStashReadScope(items, identity);
    recordStashReadScope(
      this.baseUrl,
      identity.discriminator,
      {
        outcome: classification.outcome,
        matchedCount: items.length,
        ownCount: classification.ownCount,
        droppedForeignCount: classification.foreignCount,
        droppedUnidentifiedCount: classification.unidentifiedCount,
        limit,
      },
      this.now(),
    );
    return classification.kept;
  }

  /** Classify a read failure, attributing a credential-less attempt to us, not to the server. */
  private readFailureCode(err: unknown): StashReadOutcomeCode {
    if (this.apiKey === "") return "key-unresolved";
    return classifyStashTransportFailure(err);
  }

  // ── exists ─────────────────────────────────────────────────────────

  /**
   * Probe stash reachability. Never throws — returns false on any error
   * (stash down means "no memory here", consistent with fail-closed).
   *
   * FNXC:StashReadScope 2026-11-19-13:41 (RUFU-1008): deliberately NOT scoped.
   * Its `?q=&limit=1` asks "did the server answer at all"; it is an auth/reachability probe, not a
   * data surface, and its `true` must never be read as "this project has memories". It therefore
   * contributes nothing to the scope counters — counting it would put a number on a request that
   * never inspects an owner.
   */
  async exists(_rootDir: string): Promise<boolean> {
    try {
      const resp = await this.httpRequest<StashSearchResponse>(
        "/api/v1/me/sessions/events/search?q=&limit=1",
        "GET",
      );
      const reachable = resp !== null && resp !== undefined;
      // RUFU-994: the probe answers "could we reach the server at all", which a 401 said no to
      // for a reason the caller could not see. `no-match` = answered but carried no body.
      this.noteReadOutcome("exists", reachable ? "ok" : "no-match", reachable ? 1 : 0);
      return reachable;
    } catch (err) {
      this.noteReadOutcome("exists", this.readFailureCode(err), 0);
      return false;
    }
  }

  // ── Capture seam (WRITE side) ──────────────────────────────────────

  /**
   * Capture a session chunk as events. Modeled on the optional capture seam.
   * Deterministic, non-LLM, best-effort: never throws, never blocks a run.
   *
   * FNXC:StashCaptureIdempotency 2026-08-05-16:06:
   * push_events_batch is idempotent via tuple upsert (replace=false semantics),
   * so re-capturing the same (session, content) tuple is a no-op. A session_id
   * namespace `fusion-<taskId>-<sessionHash>` never collides with the stash
   * pi-plugin's `sess_*` session ids.
   */
  /**
   * Capture memory events via POST /api/v1/me/sessions/events/batch.
   * Best-effort: never throws. On any failure returns {ok:false}.
   *
   * FNXC:StashEventShape 2026-08-07-10:39:
   * Stash's HistoryEventCreateRequest requires top-level `agent_name` (1-64)
   * and `session_id` (1-64) on every event — they are NOT optional metadata.
   * Sending them only inside `metadata` makes the server return 422 and the
   * capture silently drop (ok:false). We therefore always surface both at the
   * top level: agent_name defaults to "fusion" for this backend, and
   * session_id is the capture session id. Verified live against stash: a
   * batch missing these fields returns 422 "Field required"; the same events
   * with them inserted return 201.
   */
  async capture(
    sessionId: string,
    events: MemoryCaptureEvent[],
    metadata?: {
      taskId?: string;
      projectRoot?: string;
      topic?: string;
      /** FNXC:RUFU121CaptureIdentity 2026-08-18-19:53: RUFU-121 identity (see MemoryBackend.capture). */
      projectId?: string;
      projectName?: string;
      chatTitle?: string;
    },
  ): Promise<MemoryCaptureResult> {
    const rootDir = metadata?.projectRoot;
    const taskId = metadata?.taskId;
    const topic = metadata?.topic;
    // FNXC:RUFU121CaptureIdentity 2026-08-18-19:53: RUFU-121 optional identity.
    const projectId = metadata?.projectId;
    const projectName = metadata?.projectName;
    const chatTitle = metadata?.chatTitle;
    const discriminator = projectDiscriminatorFor(rootDir);
    /*
    FNXC:RUFU121FolderAssignment 2026-08-18-19:53:
    RUFU-121: every batch event is classified into the per-project Stash
    session folder when a project identity is available; an absent projectId
    keeps today's folder-less capture (backward compat).
    */
    const sessionFolderId = projectId ? await this.resolveProjectFolderId(projectId, projectName) : undefined;
    const tagged = events.map((e) => ({
      ...e,
      // Surface the stash-required top-level identifiers — metadata.tags are
      // provenance only and must not be confused with required request fields.
      agent_name: e.agent_name ?? "fusion",
      session_id: (e as StashEvent).session_id ?? sessionId,
      ...(sessionFolderId ? { session_folder_id: sessionFolderId } : {}),
      metadata: {
        ...(e.metadata ?? {}),
        discriminator,
        task_id: taskId,
        session_id: sessionId,
        // RUFU-035: capture stays topic-agnostic for write — every session is
        // still captured. The active topic is only recorded as session metadata
        // so a topic-aware search route can filter on it.
        ...(topic ? { topic } : {}),
        // FNXC:RUFU121MetadataEnrichment 2026-08-18-19:53:
        // RUFU-121 identity enrichment — keys appear only when the value is
        // present (never `undefined` spam).
        ...(projectId ? { project: projectId } : {}),
        ...(projectName ? { project_name: projectName } : {}),
        ...(chatTitle ? { chat_title: chatTitle } : {}),
      },
    }));
    if (tagged.length === 0) {
      // The captureMemory facade already no-ops on an empty list; keep the sink
      // safe for direct callers too (an empty POST is never issued).
      return { inserted: 0, deduped: 0, ok: true };
    }
    /*
    FNXC:RUFU122ChunkedUpload 2026-08-19-04:30:
    RUFU-122: Stash caps events per /events/batch POST at 100 (verified against
    the live instance in preflight); the task terminal transcript (up to 20000
    events) must therefore upload in sequential 100-event chunks — one chunk
    per POST, no retries, stop at the first failed chunk. `inserted`/`deduped`
    accumulate the LEADING successful chunks (the partial result); ok:true only
    when EVERY chunk succeeded, so a partial upload is always distinguishable
    from a full one. The pre-cap path (tagged.length <= 100) issues exactly one
    POST of the full tagged array — byte-identical to the previous single-upload
    wire contract. Dedup remains server-side per-event content addressing: each
    chunk is an ordinary batch POST. Never throws.
    */
    let inserted = 0;
    let deduped = 0;
    let allChunksSucceeded = true;
    for (let start = 0; start < tagged.length; start += STASH_EVENT_BATCH_CHUNK_SIZE) {
      const chunk = tagged.slice(start, start + STASH_EVENT_BATCH_CHUNK_SIZE);
      try {
        const raw = (await this.batchUpload(discriminator, chunk)) as unknown;
        // FNXC:StashEmptyBatch2xx 2026-08-21-13:35:
        // RUFU-146 review (PRRT_kwDOSA-8Y86bC_sK): a 2xx with an empty body
        // (204, or a 200 whose FFI layer emits no payload) is a VALID zero
        // count — the transport resolves it to null, and treating it as a
        // failure previously flipped ok:false (and stopped the chunk loop)
        // on every such server. Count it as a successful 0-inserted chunk.
        if (raw == null) continue;
        // Stash returns a JSON array ([HistoryEventResponse]) for /events/batch;
        // older/FFI mocks return { inserted, deduped }. Accept both so the count
        // is meaningful and unit tests stay green (FNXC:StashEventShape).
        inserted += Array.isArray(raw)
          ? raw.length
          : ((raw as StashBatchResponse).inserted ?? (raw as StashBatchResponse).count ?? 0);
        deduped += Array.isArray(raw) ? 0 : ((raw as StashBatchResponse).deduped ?? 0);
      } catch {
        // Partial failure: keep the leading chunks' counts, stop, and mark the
        // upload incomplete — no retries, no further chunks.
        allChunksSucceeded = false;
        break;
      }
    }
    return { inserted, deduped, ok: allChunksSucceeded };
  }

  /** End session — no-op for a stateless REST backend. */
  async endSession(_sessionId: string): Promise<void> {
    // Stash capture is per-event and idempotent; there is no server session to flush.
    return;
  }

  // ── Private HTTP helpers ───────────────────────────────────────────

  /** POST /api/v1/me/sessions/events/batch — idempotent push_events_batch. */
  private async batchUpload(discriminator: string, events: StashEvent[]): Promise<StashBatchResponse> {
    return this.httpRequest<StashBatchResponse>("/api/v1/me/sessions/events/batch", "POST", {
      events: events.map((e) => ({
        ...e,
        // FNXC:StashEventShape 2026-08-07-10:39: fail-closed last line of defence.
        // Stash rejects any event missing top-level agent_name / session_id with
        // 422. Capture and write already surface both, but keep a default here so
        // a future caller can never silently drop a capture to a 422.
        agent_name: e.agent_name ?? "fusion",
        session_id: e.session_id ?? this.sessionIdFor(""),
        metadata: { ...(e.metadata ?? {}), discriminator },
      })),
    });
  }

  /**
   * FNXC:RUFU121TransportSeam 2026-08-18-19:53:
   * RUFU-121: thin typed wrapper over the injectable transport seam. The real
   * node:http transport moved to module-level `stashHttpJsonRequest` so the
   * standalone helpers share it without a backend instance; behavior is
   * unchanged (10s timeout, Bearer auth, 2xx-only).
   */
  private httpRequest<T>(path: string, method: StashHttpMethod, body?: unknown): Promise<T> {
    return this.client(path, method, body) as Promise<T>;
  }
}

// ── Standalone Stash helpers (RUFU-121) ──────────────────────────────

/**
 * FNXC:RUFU121StructuredQuery 2026-08-18-19:53:
 * RUFU-121: filters for Stash's structured event-query endpoint
 * (GET /api/v1/me/sessions/events — the verified route in the Stash checkout;
 * the spec's shorthand `GET /api/v1/me/events` is not a real route).
 */
export interface StashEventQueryFilters {
  /** Exact-match filter on the event's top-level agent_name. */
  agentName?: string;
  /** Exact-match filter on the event's top-level session_id. */
  sessionId?: string;
  /** Exact-match filter on the event's top-level event_type. */
  eventType?: string;
  /** ISO-8601 lower bound (inclusive). */
  after?: string;
  /** ISO-8601 upper bound (exclusive). */
  before?: string;
  /** Result cap, clamped to 1..200 (Stash's hard limit). Default 50. */
  limit?: number;
  /** Result ordering. Default "desc" (newest first). */
  order?: "asc" | "desc";
}

/** Build the structured event-query path (query string included). */
function buildStashEventQueryPath(filters: StashEventQueryFilters): string {
  const params: string[] = [];
  if (filters.agentName !== undefined) params.push(`agent_name=${encodeURIComponent(filters.agentName)}`);
  if (filters.sessionId !== undefined) params.push(`session_id=${encodeURIComponent(filters.sessionId)}`);
  if (filters.eventType !== undefined) params.push(`event_type=${encodeURIComponent(filters.eventType)}`);
  if (filters.after !== undefined) params.push(`after=${encodeURIComponent(filters.after)}`);
  if (filters.before !== undefined) params.push(`before=${encodeURIComponent(filters.before)}`);
  params.push(`limit=${Math.max(1, Math.min(filters.limit ?? 50, 200))}`);
  params.push(`order=${filters.order === "asc" ? "asc" : "desc"}`);
  return `/api/v1/me/sessions/events?${params.join("&")}`;
}

/**
 * FNXC:RUFU121StructuredQuery 2026-08-18-19:53:
 * RUFU-121: one-shot structured query of Stash's event store (the recall
 * seam for RUFU-120). Returns { events, hasMore }; malformed/missing
 * `events` degrades to []. Transport errors PROPAGATE to the caller — the
 * caller owns degradation policy (this is a query helper, not the
 * best-effort capture/delete path). `http` injects a recorder fake in
 * tests; default is the real node:http transport.
 */
export async function queryStashEvents(
  baseUrl: string,
  apiKey: string,
  filters: StashEventQueryFilters = {},
  http?: StashHttpClient,
): Promise<{ events: Array<Record<string, unknown>>; hasMore: boolean }> {
  const base = (baseUrl ?? DEFAULT_STASH_URL).replace(/\/+$/, "");
  const client: StashHttpClient =
    http ?? ((path, method, payload) => stashHttpJsonRequest(base, apiKey, path, method, payload));
  const resp = (await client(buildStashEventQueryPath(filters), "GET")) as
    | { events?: unknown; has_more?: unknown }
    | null;
  const raw = resp?.events;
  const events = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
  return { events, hasMore: resp?.has_more === true };
}

/**
 * FNXC:RUFU121DeleteSync 2026-08-18-19:53:
 * RUFU-121: result of the best-effort chat-session soft-delete sync.
 * `deleted` is true only on a confirmed DELETE; `status` distinguishes
 * "confirmed delete" / "nothing to delete (row absent / 404)" / "skipped
 * (network/5xx — session remains in Stash)".
 */
export interface StashChatSessionDeleteResult {
  deleted: boolean;
  status: "ok" | "not-found" | "skipped";
}

/**
 * FNXC:RUFU121DeleteSync 2026-08-18-19:53:
 * RUFU-121: soft-delete the Stash session row whose top-level `session_id`
 * matches a Fusion chat session id. Best-effort: NEVER throws.
 *
 * Single-shot by-id lookup (RUFU-130): GET /api/v1/me/sessions/<session_id>
 * returns the row directly (scope-bound, read-gated); on 200 take the row
 * uuid from the payload `id` field and issue
 * DELETE /api/v1/me/sessions/<row-uuid> (204) — the per-row delete
 * contract is unchanged. 404 → "not-found" (identical semantics to the
 * old windowed-scan miss: absent, unreadable, or already soft-deleted);
 * network/5xx → "skipped" (session remains in Stash — acceptable,
 * best-effort contract).
 *
 * FNXC:RUFU130ByIdLookup 2026-08-19-16:43:
 * RUFU-130: replaces RUFU-121's windowed session-list scan (client-side
 * session_id matching over the global recent window) by the single-shot
 * by-id lookup, removing the bounded-sync residual where sessions outside
 * the recent window were never found and deleted chats leaked into Stash.
 * The by-id lookup GET /api/v1/me/sessions/{session_id} is verified
 * deployed on the live backend (RUFU-129 Step 1); it returns the row with
 * `id` (the row uuid, always a string) or 404 when absent. A 200 payload
 * without a usable `id` is treated as not-found WITHOUT issuing a DELETE
 * (defense in depth — mirrors the old null-row-id behavior). The per-row
 * delete contract is unchanged, and the RUFU-125 bulk path remains paged.
 *
 * FNXC:RUFU131AdoptionBlocker 2026-09-06-02:51:
 * The bulk adoption follow-up RUFU-131 is ARCHIVED, not pending. Verified against Stash
 * origin/main tip c56f81c9: POST /api/v1/me/batch/delete exists but is page/file-only —
 * _TRASHABLE={"page","file"} (backend/services/batch_service.py) rejects sessions. The
 * bulk path stays paged until upstream ships a session-capable bulk delete; RUFU-131 is
 * historical provenance only (CEO decision msg-551729e5; re-open trigger in project memory).
 */
export async function deleteStashChatSession(
  baseUrl: string,
  apiKey: string,
  sessionId: string,
  http?: StashHttpClient,
): Promise<StashChatSessionDeleteResult> {
  const base = (baseUrl ?? DEFAULT_STASH_URL).replace(/\/+$/, "");
  const client: StashHttpClient =
    http ?? ((path, method, payload) => stashHttpJsonRequest(base, apiKey, path, method, payload));
  try {
    const resp = await client(`/api/v1/me/sessions/${encodeURIComponent(sessionId)}`, "GET");
    const rowId = (resp as { id?: unknown } | null)?.id;
    const rowIdStr = typeof rowId === "string" ? rowId : typeof rowId === "number" ? String(rowId) : undefined;
    if (!rowIdStr) return { deleted: false, status: "not-found" };
    await client(`/api/v1/me/sessions/${encodeURIComponent(rowIdStr)}`, "DELETE");
    return { deleted: true, status: "ok" };
  } catch (err) {
    /*
    FNXC:RUFU121DeleteSync 2026-08-18-19:53:
    404 from either call means nothing to delete; anything else (network/5xx)
    is a skip — the dashboard route must never observe a throw from this path.
    */
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("404")) return { deleted: false, status: "not-found" };
    return { deleted: false, status: "skipped" };
  }
}

// ── Bulk chat-session delete sync (RUFU-125) ─────────────────────────────

/**
 * FNXC:RUFU125BulkArchiveSync 2026-08-19-06:07:
 * RUFU-125: default page cap for the bulk session-list scan — 10 pages ×
 * 200 rows = a 2000-row lookback. Stash's session list has no by-session-id
 * filter, so the scan pages `GET /api/v1/me/sessions?limit=200&offset=<n*200>`
 * in `last_event_at DESC` order until every target matched, the server
 * window is exhausted (a page returns < 200 rows), or the cap is reached.
 * Rows older than the window are NOT soft-deleted — documented residual,
 * debug-logged at the call site.
 */
export const DEFAULT_STASH_BULK_MAX_PAGES = 10;

/**
 * FNXC:RUFU125BulkArchiveSync 2026-08-19-06:07:
 * RUFU-125: counters for the bulk soft-delete sync. `targets` is the
 * de-duplicated, blank-stripped id count; `matched` counts listed rows whose
 * top-level `session_id` was a target; `deleted` counts confirmed 2xx
 * DELETEs; `pagesScanned` counts session-list pages fetched; `truncated`
 * is true ONLY when the scan stopped (page cap or GET failure) with
 * unmatched targets still outstanding — those rows remain in Stash.
 */
export interface StashBulkChatSessionDeleteResult {
  targets: number;
  matched: number;
  deleted: number;
  pagesScanned: number;
  truncated: boolean;
}

/**
 * FNXC:RUFU125BulkArchiveSync 2026-08-19-06:07:
 * RUFU-125: soft-delete the Stash session rows matching a BULK of Fusion
 * chat session ids. The task-planner archival path bulk-deletes local chat
 * sessions via ChatStore.deleteSessionsForAgentId, which bypasses the
 * per-session `DELETE /api/chat/sessions/:id` route RUFU-121 hooks — so
 * the matching Stash rows lingered. This is the batched twin of
 * deleteStashChatSession, which RUFU-130 migrated to the single-shot by-id
 * lookup (GET /api/v1/me/sessions/{session_id}); the bulk path has no such
 * per-id endpoint yet, so this one pages
 * `GET /api/v1/me/sessions?limit=200&offset=<pages*200>` (rows arrive
 * `last_event_at DESC`) until upstream ships a session-capable bulk delete, then
 * `DELETE /api/v1/me/sessions/<row.id>` (204) per matched row.
 *
 * FNXC:RUFU131AdoptionBlocker 2026-09-06-02:51:
 * Formerly deferred to RUFU-131, now ARCHIVED (historical provenance only). Verified
 * against Stash origin/main tip c56f81c9: today's POST /api/v1/me/batch/delete is
 * page/file-only — _TRASHABLE={"page","file"} (backend/services/batch_service.py)
 * rejects sessions — so there is no session-capable endpoint to adopt yet. Re-open
 * trigger: upstream gains a session-capable bulk delete (CEO decision msg-551729e5).
 *
 * Contract (best-effort, mirrors RUFU-121):
 * - NEVER throws. Blank/non-string ids are dropped and duplicates collapsed
 *   before any HTTP; an empty target set returns a zeroed result with ZERO
 *   HTTP calls.
 * - A row matches iff its `session_id` is a string still in the target set.
 *   Only rows with a non-null `id` (string|number → String) are matchable —
 *   a null row id means the row is already soft-deleted (the endpoint still
 *   lists such rows with `id: null`); they are skipped but still consume a
 *   lookback slot (they occupy the page they appear on).
 * - A GET failure mid-scan stops the scan with a PARTIAL result (no throw);
 *   a DELETE 404 → row not counted (concurrent delete); any other DELETE
 *   error → row not counted, remaining rows still attempted.
 * - `truncated: true` iff the scan stopped at the page cap or on a GET
 *   failure while unmatched targets remain; `false` when all targets
 *   matched or the server window was fully scanned.
 *
 * Documented residual: rows older than the page-cap window are not
 * soft-deleted and remain in Stash — the caller debug-logs the miss.
 */
export async function deleteStashChatSessions(
  baseUrl: string,
  apiKey: string,
  sessionIds: string[],
  opts?: { http?: StashHttpClient; maxPages?: number },
): Promise<StashBulkChatSessionDeleteResult> {
  const targets = [...new Set(sessionIds.filter((id) => typeof id === "string" && id.trim().length > 0))];
  if (targets.length === 0) {
    return { targets: 0, matched: 0, deleted: 0, pagesScanned: 0, truncated: false };
  }
  const maxPages = Math.max(1, opts?.maxPages ?? DEFAULT_STASH_BULK_MAX_PAGES);
  const base = (baseUrl ?? DEFAULT_STASH_URL).replace(/\/+$/, "");
  const client: StashHttpClient =
    opts?.http ?? ((path, method, payload) => stashHttpJsonRequest(base, apiKey, path, method, payload));

  const remaining = new Set(targets);
  let matched = 0;
  let deleted = 0;
  let pagesScanned = 0;
  let windowExhausted = false;
  try {
    for (let page = 0; page < maxPages && remaining.size > 0; page += 1) {
      pagesScanned = page + 1;
      let resp: unknown = null;
      try {
        resp = await client(`/api/v1/me/sessions?limit=200&offset=${page * 200}`, "GET");
      } catch {
        break; // GET failure mid-scan → partial result, never throw
      }
      const raw = (resp as { sessions?: unknown } | null)?.sessions;
      const rows = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
      for (const row of rows) {
        const sessionId = row?.session_id;
        if (typeof sessionId !== "string" || !remaining.has(sessionId)) continue;
        remaining.delete(sessionId);
        matched += 1;
        const rowId = row?.id;
        const rowIdStr =
          typeof rowId === "string" ? rowId : typeof rowId === "number" ? String(rowId) : undefined;
        if (!rowIdStr) continue; // null id: already soft-deleted — not matchable, slot consumed
        try {
          await client(`/api/v1/me/sessions/${encodeURIComponent(rowIdStr)}`, "DELETE");
          deleted += 1;
        } catch {
          // 404 → concurrent delete; 5xx/network → row stays. Either way the
          // row is not counted deleted and the scan continues with the rest.
        }
      }
      if (rows.length < 200) {
        windowExhausted = true;
        break; // server window exhausted — no further pages exist
      }
    }
  } catch {
    // Defense in depth: every inner call is already caught; this keeps the
    // never-throw contract honest if a future edit regresses one of them.
  }
  return {
    targets: targets.length,
    matched,
    deleted,
    pagesScanned,
    truncated: remaining.size > 0 && !windowExhausted,
  };
}

/**
 * FNXC:RUFU125BulkArchiveSync 2026-08-19-06:07:
 * RUFU-125: structural store surface for bulkDeleteStashChatSessions —
 * `getSettings()` plus the RUFU-121 StashSecretsReader duck type. A real
 * TaskStore satisfies it (its `Settings` type carries the
 * `[key: string]: unknown` index signature, so it is assignable to
 * MemoryBackendSettings).
 */
export interface StashBulkDeleteStore extends StashSecretsReader {
  getSettings(): Promise<MemoryBackendSettings | undefined>;
}

/**
 * FNXC:RUFU125BulkArchiveSync 2026-08-19-06:07:
 * RUFU-125: outcome of the store-resolving bulk sync wrapper. `skipped`
 * (with `skipReason`) = the sync deliberately made ZERO Stash calls — the
 * identical skip conditions as RUFU-121's per-session route sync; `skipped:
 * false` + `result` = the paged scan ran. `sync-error` covers the
 * unreachable-by-contract safety net so the never-throw promise survives a
 * future regression in a dependency.
 */
export type StashBulkChatSessionSyncSummary =
  | {
      skipped: true;
      skipReason:
        | "settings-error"
        | "memory-disabled"
        | "non-stash-backend"
        | "unresolvable-credentials"
        | "no-sessions"
        | "sync-error";
    }
  | { skipped: false; result: StashBulkChatSessionDeleteResult };

/**
 * FNXC:RUFU125BulkArchiveSync 2026-08-19-06:07:
 * RUFU-125: store-resolving wrapper for the bulk sync. Mirrors RUFU-121's
 * route skip-guards byte-for-byte — settings read, resolveStashMemorySettings
 * (per-project `stashApiKey` override wins, else the global secrets-store
 * `stash-api-key`), the same trim + DEFAULT_STASH_URL fallback the route
 * uses (mirrors resolveMemoryBackend), then the API-key gate. NEVER throws:
 * a `getSettings` rejection degrades to `settings-error`; the outer catch is
 * an unreachable safety net (resolveStashMemorySettings and
 * deleteStashChatSessions both degrade internally).
 */
export async function bulkDeleteStashChatSessions(
  store: StashBulkDeleteStore,
  sessionIds: string[],
  opts?: { http?: StashHttpClient; maxPages?: number },
): Promise<StashBulkChatSessionSyncSummary> {
  const targets = [...new Set(sessionIds.filter((id) => typeof id === "string" && id.trim().length > 0))];
  try {
    let settings: MemoryBackendSettings | undefined;
    try {
      settings = await store.getSettings();
    } catch {
      return { skipped: true, skipReason: "settings-error" };
    }
    const resolved = await resolveStashMemorySettings(store, settings);
    if (!resolved || resolved.memoryEnabled === false) {
      return { skipped: true, skipReason: "memory-disabled" };
    }
    if (resolved.memoryBackendType !== "stash") {
      return { skipped: true, skipReason: "non-stash-backend" };
    }
    const rawStashUrl = resolved.stashUrl;
    const stashUrl =
      typeof rawStashUrl === "string" && rawStashUrl.trim().length > 0
        ? rawStashUrl.trim()
        : DEFAULT_STASH_URL;
    const stashApiKey = resolved.stashApiKey;
    if (!stashApiKey) return { skipped: true, skipReason: "unresolvable-credentials" };
    if (targets.length === 0) return { skipped: true, skipReason: "no-sessions" };
    const result = await deleteStashChatSessions(stashUrl, stashApiKey, targets, opts);
    return { skipped: false, result };
  } catch {
    // Unreachable by contract — both awaited dependencies degrade internally.
    return { skipped: true, skipReason: "sync-error" };
  }
}