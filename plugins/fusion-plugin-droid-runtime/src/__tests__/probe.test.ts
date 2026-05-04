import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const proc = new EventEmitter() as any;
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    queueMicrotask(() => proc.emit("error", Object.assign(new Error("not found"), { code: "ENOENT" })));
    return proc;
  }),
}));

import { probeDroidBinary } from "../probe.js";

describe("probeDroidBinary", () => {
  it("returns unavailable when binary is missing", async () => {
    const result = await probeDroidBinary({ timeoutMs: 10 });
    expect(result.available).toBe(false);
  });
});
