import { describe, expect, it, afterAll } from "vitest";
import { Worker } from "node:worker_threads";
import {
  buildPgStartupMessage,
  classifyPgStartupResponse,
  parsePgProbeTarget,
  probePgUsable,
  type PgProbeTarget,
} from "../__test-utils__/pg-startup-probe.js";

/*
FNXC:PgProbeAuth 2026-11-09-09:42 (RUFU-517):
The probe's verdict decides whether every `pgDescribe` suite runs or silently skips, so both
directions of error are expensive and both are pinned here:
- Under-reporting was the shipped defect. A live server that answers TCP but refuses the
  identity (measured: a foreign container squatting `localhost:5432` answering `R`/SASL to
  `postgresql://localhost:5432`) made three workspace land/finalize files fail mid-run with
  `password authentication failed for user "schindler"` instead of skipping as documented.
- Over-reporting is the failure mode the original probe was written to prevent (the 57 PG
  suites went dead in CI when availability was a truthy string). So an auth demand we could
  have answered — a URL that carries a password — must NEVER count as refusal, which is
  exactly CI's `postgresql://postgres:postgres@localhost:5432` shape.
Servers are in-process fakes on port 0 and the probe's own timeout is narrowed, so this file
adds no real PostgreSQL dependency and no wall-clock wait.
*/

/**
 * Fake servers in a Worker thread, NOT in this thread.
 *
 * `probePgUsable` blocks the calling thread on `Atomics.wait` by design
 * (`PG_AVAILABLE` is read at module load, where vitest's `describe` is
 * synchronous). A server listening on the blocked event loop would never reach
 * its own `data` handler, so every scripted reply would time out and the probe
 * would report its keep-TCP verdict — an AuthenticationOk case would then pass
 * for exactly the wrong reason. The worker owns a separate event loop and stays
 * responsive while the test thread blocks.
 */
function startFakeServerWorker(): { port(id: string): Promise<number>; terminate(): Promise<void> } {
  const workerCode = `
    const { parentPort } = require("node:worker_threads");
    const { createServer } = require("node:net");
    const servers = new Map();
    parentPort.on("message", (msg) => {
      if (msg.op === "listen") {
        for (const scenario of msg.scenarios) {
          const reply = scenario.reply ? Buffer.from(scenario.reply) : null;
          const server = createServer((socket) => {
            if (reply === null) return; // accept and stay silent
            socket.once("data", () => { socket.write(reply); socket.end(); });
          });
          server.listen(0, "127.0.0.1", () => {
            const port = server.address().port;
            if (scenario.closeAfterListen) return server.close(() => parentPort.postMessage({ id: scenario.id, port }));
            servers.set(scenario.id, server);
            parentPort.postMessage({ id: scenario.id, port });
          });
        }
      }
    });
  `;
  const worker = new Worker(workerCode, { eval: true });
  const ports = new Map<string, number>();
  const waiters: Array<() => void> = [];
  worker.on("message", (msg: { id: string; port: number }) => {
    ports.set(msg.id, msg.port);
    for (const resolve of waiters.splice(0)) resolve();
  });
  const ids = ["authOk", "sasl", "error", "silent", "closedPort"];
  const scenarios = ids.map((id) => ({
    id,
    reply:
      id === "authOk"
        ? authRequestBytes(0)
        : id === "sasl"
          ? authRequestBytes(10)
          : id === "error"
            ? errorResponseBytes()
            : null,
    // Bound then released: a port nobody listens on answers the connect itself with RST.
    closeAfterListen: id === "closedPort",
  }));
  worker.postMessage({ op: "listen", scenarios });
  return {
    async port(id: string): Promise<number> {
      const deadline = Date.now() + 5000;
      while (!ports.has(id) && Date.now() < deadline) {
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 25);
        });
      }
      const port = ports.get(id);
      if (port === undefined) throw new Error(`fake PG server "${id}" never listened`);
      return port;
    },
    async terminate(): Promise<void> {
      await worker.terminate();
    },
  };
}

function authRequestBytes(subtype: number): number[] {
  const payload = Buffer.alloc(4);
  payload.writeUInt32BE(subtype, 0);
  return Array.from(pgMessageBytes("R", payload));
}

function authRequestBuffer(subtype: number): Buffer {
  return Buffer.from(authRequestBytes(subtype));
}

function errorResponseBytes(): number[] {
  return Array.from(pgMessageBytes("E", Buffer.from("F28P00\0password authentication failed\0\0")));
}

function pgMessageBytes(type: string, payload: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length + 4, 0);
  return Buffer.concat([Buffer.from(type, "ascii"), length, payload]);
}

function target(port: number, overrides: Partial<PgProbeTarget> = {}): PgProbeTarget {
  return { host: "127.0.0.1", port, user: "postgres", database: "postgres", hasPassword: false, ...overrides };
}

const probe = (port: number, overrides: Partial<PgProbeTarget> = {}) => probePgUsable(target(port, overrides), 400);

describe("PG startup probe classification", () => {
  it("reports a server that accepted the handshake as usable", () => {
    expect(classifyPgStartupResponse(authRequestBuffer(0), false)).toBe("usable");
  });

  it("proves refusal when the server demands a credential the URL does not carry", () => {
    // Measured wire reply of the foreign server on the default port: SASL (10). MD5 (5) and
    // cleartext (3) are the same refusal from this harness's point of view.
    for (const subtype of [3, 5, 10]) {
      expect(classifyPgStartupResponse(authRequestBuffer(subtype), false)).toBe("proven-unusable");
    }
  });

  it("never proves refusal for a URL that carries a password", () => {
    // CI shape. The probe does not negotiate SCRAM, so it cannot claim the password is wrong.
    expect(classifyPgStartupResponse(authRequestBuffer(10), true)).toBe("indeterminate");
    expect(classifyPgStartupResponse(authRequestBuffer(3), true)).toBe("indeterminate");
  });

  it("treats a server ErrorResponse as proof this identity cannot connect", () => {
    expect(
      classifyPgStartupResponse(
        pgMessageBytes("E", Buffer.from("F28P00\0password authentication failed\0\0")),
        false,
      ),
    ).toBe("proven-unusable");
    // Even with a password: the server answered as PostgreSQL and said no.
    expect(classifyPgStartupResponse(pgMessageBytes("E", Buffer.from("F28P00\0\0")), true)).toBe("proven-unusable");
  });

  it("keeps availability for anything it cannot read as a PostgreSQL refusal", () => {
    expect(classifyPgStartupResponse(undefined, false)).toBe("indeterminate");
    expect(classifyPgStartupResponse(Buffer.from([0x52, 0, 0, 0, 4, 0]), false)).toBe("indeterminate"); // truncated header
    expect(classifyPgStartupResponse(Buffer.from("SSH-2.0-OpenSSH"), false)).toBe("indeterminate"); // a non-PG banner
  });
});

describe("PG startup message shape", () => {
  it("is length-prefixed protocol 3.0 with NUL-terminated key/value pairs", () => {
    const bytes = buildPgStartupMessage("pguser", "postgres");
    const buf = Buffer.from(bytes);
    expect(buf.readUInt32BE(0)).toBe(bytes.length);
    expect(buf.readUInt32BE(4)).toBe(196608); // 3.0
    const text = buf.subarray(8).toString("utf8");
    expect(text.startsWith("user\0pguser\0database\0postgres\0")).toBe(true);
    expect(text.endsWith("\0")).toBe(true);
  });
});

describe("PG probe target parsing", () => {
  it("defaults to the maintenance database and an unpassworded local endpoint", () => {
    const parsed = parsePgProbeTarget("postgresql://localhost:5432");
    expect(parsed).toMatchObject({ host: "localhost", port: 5432, database: "postgres", hasPassword: false });
    expect(parsed.user.length).toBeGreaterThan(0); // the OS role the client would present
  });

  it("keeps a URL's own role, database, and password presence", () => {
    const parsed = parsePgProbeTarget("postgresql://postgres:postgres@127.0.0.1:55455/fusion_maint");
    expect(parsed).toMatchObject({
      host: "127.0.0.1",
      port: 55455,
      user: "postgres",
      database: "fusion_maint",
      hasPassword: true,
    });
  });

  it("falls back to the default endpoint for an unparseable URL", () => {
    expect(parsePgProbeTarget("not a url")).toMatchObject({ host: "localhost", port: 5432, hasPassword: false });
  });
});

describe("PG probe against live fakes", () => {
  const fakes = startFakeServerWorker();

  afterAll(async () => {
    await fakes.terminate();
  });

  it("runs the suite when the server answers AuthenticationOk", async () => {
    expect(await probe(await fakes.port("authOk"))).toEqual({ usable: true, refused: false });
  });

  it("skips instead of crashing when the server demands a credential the URL lacks", async () => {
    expect(await probe(await fakes.port("sasl"))).toEqual({ usable: false, refused: true });
  });

  it("keeps the suite when the same demand arrives for a credentialed URL", async () => {
    expect(await probe(await fakes.port("sasl"), { hasPassword: true })).toEqual({ usable: true, refused: false });
  });

  it("skips when the server answers as PostgreSQL with an error", async () => {
    expect(await probe(await fakes.port("error"))).toEqual({ usable: false, refused: true });
  });

  it("keeps the TCP verdict for a port that accepts but never speaks", async () => {
    expect(await probe(await fakes.port("silent"))).toEqual({ usable: true, refused: false });
  });

  it("reports nothing usable for a port that refuses the connection at all", async () => {
    expect(await probe(await fakes.port("closedPort"))).toEqual({ usable: false, refused: false });
  });
});
