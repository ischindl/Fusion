import { userInfo } from "node:os";
import { Worker } from "node:worker_threads";

/*
FNXC:PgProbeAuth 2026-11-09-09:42 (RUFU-517):
The PostgreSQL availability probe lives here, apart from the harness, for one reason: the harness
computes PG_AVAILABLE at MODULE LOAD, so a test that imports the harness pays a live network probe
and cannot inject a server. Splitting the decision from its consumer is what lets the refusal rule
be pinned against an in-process fake — the rule decides whether 57 pgDescribe suites run or skip,
and a rule nobody can test is how this file's TCP-only probe shipped an un-caught defect: a server
that accepts TCP but refuses authentication made three workspace land/finalize files crash mid-run
with "password authentication failed" instead of skipping as documented.
*/

/** A probe target derived from a PG test URL, in the shape the client library will present. */
export interface PgProbeTarget {
  host: string;
  port: number;
  user: string;
  database: string;
  hasPassword: boolean;
}

/**
 * FNXC:FixPgTestsAndCi 2026-06-26-09:00:
 * Parse the host/port out of a PG test URL so a synchronous probe can detect whether the
 * server is reachable. Falls back to localhost:5432 for a malformed or port-less URL.
 *
 * FNXC:PgProbeAuth 2026-11-09-09:42 (RUFU-517):
 * The handshake needs the identity too, and it must be the SAME one the harness presents:
 * every admin URL is repointed at the "postgres" maintenance database, and the client falls
 * back to the OS user when the URL names none. Whether the URL carries a password decides how
 * much the handshake can prove — see classifyPgStartupResponse.
 */
export function parsePgProbeTarget(url: string): PgProbeTarget {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname || "localhost";
    const port = parsed.port ? Number.parseInt(parsed.port, 10) : 5432;
    const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, "")) || "postgres";
    return {
      host,
      port: Number.isFinite(port) ? port : 5432,
      user: decodeURIComponent(parsed.username) || defaultProbeUser(),
      database,
      hasPassword: Boolean(parsed.password),
    };
  } catch {
    return { host: "localhost", port: 5432, user: defaultProbeUser(), database: "postgres", hasPassword: false };
  }
}

/** The role the client presents when the URL names none. Never throws in a sandbox. */
function defaultProbeUser(): string {
  try {
    return process.env.USER || userInfo().username || "postgres";
  } catch {
    return "postgres";
  }
}

const PG_MESSAGE_AUTH_REQUEST = 0x52; // 'R'
const PG_MESSAGE_ERROR_RESPONSE = 0x45; // 'E'
const PG_AUTH_OK_SUBTYPE = 0;

/**
 * What one observed startup reply proves about this URL's PostgreSQL server.
 *
 * - `usable` — the server accepted the handshake (AuthenticationOk).
 * - `proven-unusable` — the server answered as a PostgreSQL server and refused
 *   this identity, so the harness's own connection provably fails the same way.
 * - `indeterminate` — nothing was observed that disproves usability (no reply,
 *   a non-PostgreSQL banner, or an auth demand we could have satisfied but did
 *   not negotiate). Availability is kept, exactly as the TCP-only probe decided.
 */
export type PgStartupVerdict = "usable" | "proven-unusable" | "indeterminate";

/**
 * FNXC:PgProbeAuth 2026-11-09-09:42 (RUFU-517):
 * Classify the FIRST server message after a StartupMessage. This is deliberately
 * a refusal-detector and never a credential test: it downgrades availability
 * ONLY on positive wire evidence that this URL cannot connect, so no host that
 * works today can be silently turned into a skipped suite. Measured on one host
 * on 2026-11-09: a foreign container squatting the default `localhost:5432`
 * answers `R`/subtype 10 (SASL) to `postgresql://localhost:5432`, which carries
 * no password — the harness then crashed mid-suite with `password authentication
 * failed for user "schindler"` in three files instead of skipping, while a
 * `trust` server on a high port answers `R`/subtype 0 and runs green. CI's
 * `postgresql://postgres:postgres@…` carries a password, so an auth demand there
 * stays `indeterminate` and its 57 pgDescribe suites keep running — a silently
 * dead PG lane is the failure mode this probe exists to prevent, not one to add.
 */
export function classifyPgStartupResponse(
  firstMessage: Uint8Array | undefined,
  hasPassword: boolean,
): PgStartupVerdict {
  if (!firstMessage || firstMessage.length < 5) return "indeterminate";
  const type = firstMessage[0];
  if (type === PG_MESSAGE_ERROR_RESPONSE) return "proven-unusable";
  if (type !== PG_MESSAGE_AUTH_REQUEST) return "indeterminate";
  if (firstMessage.length < 9) return "indeterminate";
  const subtype =
    ((firstMessage[5] << 24) |
      (firstMessage[6] << 16) |
      (firstMessage[7] << 8) |
      firstMessage[8]) >>>
    0;
  if (subtype === PG_AUTH_OK_SUBTYPE) return "usable";
  return hasPassword ? "indeterminate" : "proven-unusable";
}

/**
 * A protocol 3.0 StartupMessage for `user`/`database` as raw bytes, so the probe
 * worker needs nothing but `node:net` (see the note on `probePgUsable` for why
 * the worker cannot resolve a real PostgreSQL client).
 */
export function buildPgStartupMessage(user: string, database: string): number[] {
  const parts: number[] = [0, 3, 0, 0]; // ProtocolVersion 3.0
  for (const field of ["user", user, "database", database]) {
    for (const byte of Array.from(Buffer.from(field, "utf8"))) parts.push(byte);
    parts.push(0);
  }
  parts.push(0);
  const length = parts.length + 4;
  return [(length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff, ...parts];
}

/**
 * FNXC:FixPgTestsAndCi 2026-06-26-09:00:
 * Synchronous probe. Returns true when a TCP connection to (host, port)
 * succeeds within a short timeout AND the PostgreSQL handshake does not prove
 * the server refuses this URL's identity. This MUST be synchronous
 * because `PG_AVAILABLE` is consumed at module-load time by conditional
 * `describe` calls (vitest's describe is synchronous).
 *
 * Implementation: spawns a Worker thread that performs the async connect. The
 * worker writes the outcome (1=connected, 2=failed) into a SharedArrayBuffer
 * and calls Atomics.notify; the main thread blocks on Atomics.wait. This is
 * the only way to bridge async I/O into a synchronous result in Node without
 * a native blocking socket addon.
 *
 * Why not just check env vars? The prior probe was
 *   `process.env.FUSION_PG_TEST_SKIP !== "1" && Boolean(PG_TEST_URL_BASE)`
 * which is ALWAYS truthy because PG_TEST_URL_BASE defaults non-empty and
 * FUSION_PG_TEST_SKIP is never set in CI — so the 57 pgDescribe suites tried
 * to run in CI without PostgreSQL and failed with ECONNREFUSED, or were
 * silently dead. The real check must verify reachability.
 *
 * Why not the `pg_isready` binary via execSync? execSync is banned by
 * AGENTS.md for non-git-plumbing, and pg_isready may be absent from some CI
 * images. The worker-thread probe has no external binary dependency.
 *
 * FNXC:PgProbeAuth 2026-11-09-09:42 (RUFU-517):
 * The worker hand-rolls the StartupMessage instead of importing `postgres`
 * because an inline `eval` worker resolves modules from the invoking package
 * (vitest runs with cwd = packages/engine) and `postgres` is not a dependency
 * of every package that loads this harness. The worker therefore speaks only
 * `node:net` and reports one of three SAB codes; all interpretation of the
 * reply happens on the main thread in `classifyPgStartupResponse`.
 */

/*
 * SAB outcome codes, mirrored by the inline worker's `report()` calls:
 * 0 = pending, 1 = usable/indeterminate, 2 = socket error while connecting,
 * 3 = proven refusal.
 *
 * FNXC:PgProbeAuth 2026-11-09-18:55 (RUFU-517):
 * Only the two codes the main thread branches on are named. Code 2 is deliberately NOT read here:
 * an errno the probe cannot classify is reported as neither usable nor refused, so the caller keeps
 * its prior TCP verdict rather than inventing one.
 */
const PG_PROBE_USABLE = 1;
const PG_PROBE_REFUSED = 3;

export function probePgUsable(target: PgProbeTarget, timeoutMs = 1500): { usable: boolean; refused: boolean } {
  const shared = new SharedArrayBuffer(4);
  const view = new Int32Array(shared);
  view[0] = 0; // 0 = pending, 1 = usable/indeterminate, 2 = TCP failed, 3 = proven refusal

  let worker: Worker | null = null;
  try {
    // Spawn a worker that performs the async connect and signals the SAB.
    // The worker source is inline (no temp file) and tiny.
    const workerCode = `
      const { parentPort } = require("node:worker_threads");
      const { Socket } = require("node:net");
      parentPort.on("message", (msg) => {
        const { host, port, timeoutMs, buf, startup } = msg;
        const view = new Int32Array(buf);
        const socket = new Socket();
        const report = (code) => { if (view[0] === 0) { view[0] = code; Atomics.notify(view, 0); } socket.destroy(); };
        socket.setTimeout(timeoutMs);
        // A silent port keeps the TCP verdict: reachability was proven, nothing disproved it.
        socket.once("timeout", () => report(1));
        socket.once("error", () => report(2));
        socket.once("connect", () => { socket.write(Buffer.from(startup)); });
        socket.once("data", (chunk) => {
          const type = chunk[0];
          if (type === 0x45) return report(3); // ErrorResponse: this identity cannot connect.
          if (type !== 0x52 || chunk.length < 9) return report(1);
          const subtype = ((chunk.readUInt32BE(5)) >>> 0);
          if (subtype === 0) return report(1); // AuthenticationOk.
          return report(msg.hasPassword ? 1 : 3);
        });
        socket.connect(port, host);
      });
    `;
    worker = new Worker(workerCode, { eval: true });
    worker.postMessage({
      host: target.host,
      port: target.port,
      timeoutMs,
      buf: shared,
      hasPassword: target.hasPassword,
      startup: buildPgStartupMessage(target.user, target.database),
    });
  } catch {
    // If worker threads are unavailable (rare), treat as unreachable so the
    // suite skips rather than hangs.
    return { usable: false, refused: false };
  }

  // Block until the worker signals or we exceed the deadline.
  const deadline = Date.now() + timeoutMs + 500;
  while (view[0] === 0 && Date.now() < deadline) {
    Atomics.wait(view, 0, 0, 100);
  }

  // Tear down the worker asynchronously; don't block on it.
  void worker.terminate().catch(() => {});

  return { usable: view[0] === PG_PROBE_USABLE, refused: view[0] === PG_PROBE_REFUSED };
}

/**
 * FNXC:PgProbeAuth 2026-11-09-09:42 (RUFU-517):
 * One warning per process when a live server proved it refuses this URL. A skip
 * must never be silent — the documented contract says an unreachable PostgreSQL
 * skips, so an operator staring at 8 skipped workspace tests needs to be told
 * which endpoint refused and how to point the harness at a server it can use.
 * The password is never printed, only host:port.
 */
