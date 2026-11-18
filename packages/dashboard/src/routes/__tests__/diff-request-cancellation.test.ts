import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

/*
FNXC:DiffLaneCancellation 2026-11-18-10:12 (RUFU-479) — witnesses for a diff read that stops when unwanted.

The measured defect these cases hold shut: a diff lane that answers in 19.96-28.35 s kept answering after the
client had navigated away, and the lane it answered in was the whole single-process dashboard. So the
contract asserted here is about the SUBPROCESS's lifetime, not the response — the response was already being
ignored by the client, and that alone is not a saved git lane.

These are route-seam contracts, not subprocess simulations: what the cancellation scope guarantees is (a) a
signal that flips on disconnect, (b) a `close` listener that does not accumulate on a reused keep-alive
socket, and (c) that the spawn receives that signal plus the kill choice it implies. A case that instead
waited on a real `git` child would be a timing test, and this repo does not add those.
*/

const execFileCalls: Array<{ args: unknown[]; options: Record<string, unknown> }> = [];

/*
The mock keeps execFile's REAL arity — `(file, args, options, callback)` — because `util.promisify` forwards
the caller's arguments and appends the callback. A three-parameter mock silently receives the callback as
`options` and never calls it, which is how this file first failed: not on an assertion, but on a hang.
*/
vi.mock("node:child_process", () => ({
  execFile: (
    _file: unknown,
    args: unknown,
    options: unknown,
    cb?: (err: null | Error, stdout?: string, stderr?: string) => void,
  ) => {
    execFileCalls.push({ args: args as unknown[], options: (options ?? {}) as Record<string, unknown> });
    cb?.(null, "mocked-stdout", "");
  },
}));

import { diffRequestCancellation, currentDiffRequestSignal } from "../diff-request-signal.js";
import { runGitCommand } from "../resolve-diff-base.js";

function fakeRequest() {
  const req = Object.assign(new EventEmitter(), { method: "GET", url: "/tasks/RUFU-479/file-diffs", params: { id: "RUFU-479" }, query: {} });
  return req;
}

function fakeResponse() {
  const res = Object.assign(new EventEmitter(), {
    json: () => res,
    status: () => res,
    send: () => res,
  });
  return res;
}

/** Runs the middleware and then `inner`, the way express would run the guarded handler downstream. */
async function runGuarded(inner: () => Promise<void> | void) {
  const req = fakeRequest();
  const res = fakeResponse();
  await new Promise<void>((resolve, reject) => {
    diffRequestCancellation(req as never, res as never, (() => {
      void Promise.resolve(inner()).then(resolve, reject);
    }) as never);
  });
  return { req, res };
}

describe("diff request cancellation scope", () => {
  beforeEach(() => {
    execFileCalls.length = 0;
  });

  it("gives the guarded handler a signal and aborts it the moment the client disconnects", async () => {
    let seen: AbortSignal | undefined;
    let release!: () => void;
    const stillRunning = new Promise<void>((resolve) => {
      release = resolve;
    });

    const run = (async () => {
      const req = fakeRequest();
      const res = fakeResponse();
      diffRequestCancellation(req as never, res as never, (() => {
        void (async () => {
          seen = currentDiffRequestSignal();
          await stillRunning;
        })();
      }) as never);
      return { req, res };
    })();
    void run;

    await Promise.resolve();
    expect(seen?.aborted).toBe(false);
    // The handler is still waiting on its git call — a disconnect at this moment is the case that matters.
    const req = (await run).req;
    req.emit("close");
    expect(seen?.aborted).toBe(true);
    release();
  });

  it("removes its close listener when the response finishes, so a reused socket does not accumulate them", async () => {
    const { req, res } = await runGuarded(async () => {
      await runGitCommand(["rev-parse", "HEAD"], "/tmp");
    });
    expect(req.listenerCount("close")).toBe(1);
    res.emit("finish");
    expect(req.listenerCount("close")).toBe(0);
  });

  it("leaves an uncancellable route running with no signal attached to its spawn", async () => {
    // The stats lane of /diff is deliberately NOT cancellable: its computation is a single-flight rendezvous
    // that answers every joined waiter, so one departing client is not entitled to kill the shared work.
    expect(currentDiffRequestSignal()).toBeUndefined();
    await runGitCommand(["rev-parse", "HEAD"], "/tmp");
    const options = execFileCalls[0]?.options as Record<string, unknown>;
    expect("signal" in options).toBe(false);
    expect("killSignal" in options).toBe(false);
  });

  it("attaches the request's signal and SIGKILL to the spawn, so a disconnect reaches the child", async () => {
    let captured: AbortSignal | undefined;
    let request!: EventEmitter;
    const run = (async () => {
      const req = fakeRequest();
      const res = fakeResponse();
      diffRequestCancellation(req as never, res as never, (() => {
        request = req;
        void (async () => {
          await runGitCommand(["diff", "--name-only"], "/tmp", 5000);
          captured = currentDiffRequestSignal();
        })();
      }) as never);
    })();
    void run;

    await Promise.resolve();
    await Promise.resolve();
    await run;

    const options = execFileCalls[0]?.options as { signal?: AbortSignal; killSignal?: string };
    expect(options.signal).toBe(captured);
    expect(options.signal?.aborted).toBe(false);
    expect(options.killSignal).toBe("SIGKILL");
    // The whole point: the disconnect that follows a navigation reaches the signal the spawn was given.
    request.emit("close");
    expect(options.signal?.aborted).toBe(true);
  });
});
