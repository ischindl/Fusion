import { describe, expect, it, vi } from "vitest";
import { dedupe } from "../client/dedupe.js";

/*
FNXC:CrossProjectHandoff 2026-09-10-18:05 (RUFU-211):
The transfer-to-project picker hung on "Loading projects…" forever, and reopening it did not recover,
because one in-flight entry under `/projects/across-nodes` can be parked by a response that never
arrives: the header switcher and the transfer picker share that key, so every later caller joins the
stuck promise instead of issuing a new request.

These tests pin the properties that make such a stall RECOVERABLE rather than permanent, at the module
seam itself with a hand-settled fake fetcher (no network, no jsdom):
1. While a request is pending the entry IS shared — that is the poisoning mechanism, and a test that
   pretended it could not happen would hide the bug.
2. The entry is dropped as soon as the parked request settles by REJECTION. An abort is exactly such a
   rejection, so a caller that gives up and cancels un-poisons the key for everyone behind it.
3. One inner fetch backs one shared promise, so a joiner cannot be spared someone else's abort at this
   layer — that guarantee lives above the seam (see fetchProjectsAcrossNodes), and pretending otherwise
   here would assert behavior this module does not have.
*/

/** A fetcher whose promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Handlers are also attached eagerly so a "settle now, assert later" step cannot surface as an
  // unhandled rejection before the awaiting assertion is reached.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function abortError(): Error {
  const err = new Error("This operation was aborted");
  err.name = "AbortError";
  return err;
}

describe("dedupe — in-flight entry lifecycle", () => {
  it("shares one request between concurrent callers (the mechanism that can park them)", async () => {
    const fetcher = vi.fn<() => Promise<string>>();
    const pending = deferred<string>();
    fetcher.mockReturnValueOnce(pending.promise);

    const a = dedupe("/dedupe-test/shared", fetcher);
    const b = dedupe("/dedupe-test/shared", fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    pending.resolve("x");
    // The second caller joined the first request instead of issuing its own — which is what makes a
    // never-settling first request a stall for BOTH callers.
    await expect(Promise.all([a, b])).resolves.toEqual(["x", "x"]);
  });

  it("leaves the entry installed while a request never settles, so a later call joins the stuck promise", async () => {
    const fetcher = vi.fn<() => Promise<string>>();
    const stuck = deferred<string>();
    fetcher.mockReturnValue(stuck.promise);

    const first = dedupe("/dedupe-test/poisoned", fetcher);
    const second = dedupe("/dedupe-test/poisoned", fetcher);

    // Nothing has settled: the key is still claimed, so a picker reopening would inherit the stall.
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    stuck.resolve("eventually");
    await expect(first).resolves.toBe("eventually");
  });

  it("un-poisons the key when the parked request settles by rejection (an abort)", async () => {
    const fetcher = vi.fn<() => Promise<string>>();
    const stuck = deferred<string>();
    const recovered = deferred<string>();
    fetcher.mockReturnValueOnce(stuck.promise).mockReturnValueOnce(recovered.promise);

    const first = dedupe("/dedupe-test/un-poison", fetcher);
    // A caller gives up and cancels: the shared request rejects.
    stuck.reject(abortError());
    await expect(first).rejects.toMatchObject({ name: "AbortError" });

    // The crux: the entry is gone, so the NEXT caller issues a brand-new request instead of joining
    // the dead one. Without this property the picker could never recover, however often it reopened.
    const retry = dedupe("/dedupe-test/un-poison", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    recovered.resolve("fresh");
    await expect(retry).resolves.toBe("fresh");
  });

  it("un-poisons the key on resolution too, so a settled request is never joined again", async () => {
    const fetcher = vi.fn<() => Promise<string>>();
    fetcher.mockResolvedValueOnce("one").mockResolvedValueOnce("two");

    await expect(dedupe("/dedupe-test/settled", fetcher)).resolves.toBe("one");
    await expect(dedupe("/dedupe-test/settled", fetcher)).resolves.toBe("two");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("fails every joiner of a rejected request together, so none resolves with nothing", async () => {
    const fetcher = vi.fn<() => Promise<string>>();
    const stuck = deferred<string>();
    fetcher.mockReturnValue(stuck.promise);

    const a = dedupe("/dedupe-test/joined-rejection", fetcher);
    const b = dedupe("/dedupe-test/joined-rejection", fetcher);
    stuck.reject(abortError());

    // Honest shape of this layer: one shared promise means a joiner observes the aborter's rejection.
    // RUFU-211 absorbs that above the seam — fetchProjectsAcrossNodes re-issues once when the abort was
    // not its own — instead of claiming dedupe can tell callers apart.
    await expect(a).rejects.toMatchObject({ name: "AbortError" });
    await expect(b).rejects.toMatchObject({ name: "AbortError" });
  });

  it("redirects joiners to a forceFresh result and discards the parked request's late resolution", async () => {
    const fetcher = vi.fn<() => Promise<string>>();
    const stale = deferred<string>();
    const fresh = deferred<string>();
    const nextRound = deferred<string>();
    fetcher
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(fresh.promise)
      .mockReturnValueOnce(nextRound.promise);

    const original = dedupe("/dedupe-test/force-fresh", fetcher);
    const forced = dedupe("/dedupe-test/force-fresh", fetcher, { forceFresh: true });
    expect(fetcher).toHaveBeenCalledTimes(2);

    fresh.resolve("fresh");
    // This is why a Retry must pass forceFresh: it bypasses the hung entry AND repairs everyone who
    // joined it — they observe the fresh snapshot rather than the pre-retry state.
    await expect(original).resolves.toBe("fresh");
    await expect(forced).resolves.toBe("fresh");

    // The parked request settles late; its result is discarded by the done-guard, and the settled key
    // starts clean — so the next caller gets a real new request.
    stale.resolve("late-stale");
    const afterSettle = dedupe("/dedupe-test/force-fresh", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(3);
    nextRound.resolve("after-settle");
    await expect(afterSettle).resolves.toBe("after-settle");
  });
});
