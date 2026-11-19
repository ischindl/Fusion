import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setLogLevelMarkerCapture } from "@fusion/core/log-severity-markers";
import {
  createLogger,
  schedulerLog,
  executorLog,
  planLog,
  mergerLog,
  worktreePoolLog,
  reviewerLog,
  remoteNodeLog,
} from "../logger.js";

/*
FNXC:LogSeverityMarkers 2026-11-19-02:47 (RUFU-666):
Default-mode stderr is byte-clean: the NUL-wrapped markers leak only to an active
severity-marker consumer. These cases pin the channels/prefixes unchanged, assert no payload
carries U+0000 by default, and keep the exact historical marker shape under the
FUSION_LOG_SEVERITY_MARKERS opt-in and under the capture flag (mirrors the core logger tests).
*/

describe("createLogger", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env.FUSION_LOG_SEVERITY_MARKERS;
    setLogLevelMarkerCapture(false);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.FUSION_LOG_SEVERITY_MARKERS;
    setLogLevelMarkerCapture(false);
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("formats log output as [prefix] message on stderr, marker-free by default", () => {
    const logger = createLogger("test");
    logger.log("hello world");
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith("[test] hello world");
    expect(errorSpy.mock.calls[0]?.[0]).not.toContain("\u0000");
  });

  it("formats warn output marker-free by default", () => {
    const logger = createLogger("test");
    logger.warn("something happened");
    expect(warnSpy).toHaveBeenCalledWith("[test] something happened");
    expect(warnSpy.mock.calls[0]?.[0]).not.toContain("\u0000");
  });

  it("formats error output marker-free by default", () => {
    const logger = createLogger("test");
    logger.error("failure");
    expect(errorSpy).toHaveBeenCalledWith("[test] failure");
    expect(errorSpy.mock.calls[0]?.[0]).not.toContain("\u0000");
  });

  it("passes extra arguments through", () => {
    const logger = createLogger("test");
    const err = new Error("boom");
    logger.error("failed:", err);
    expect(errorSpy).toHaveBeenCalledWith("[test] failed:", err);
  });

  it("emits the exact severity markers when FUSION_LOG_SEVERITY_MARKERS is opted in", () => {
    process.env.FUSION_LOG_SEVERITY_MARKERS = "1";
    const logger = createLogger("test");
    logger.log("hello world");
    logger.warn("something happened");
    logger.error("failure");
    expect(errorSpy).toHaveBeenCalledWith("\u0000fnlvl=info\u0000[test] hello world");
    expect(warnSpy).toHaveBeenCalledWith("\u0000fnlvl=warn\u0000[test] something happened");
    expect(errorSpy).toHaveBeenCalledWith("\u0000fnlvl=error\u0000[test] failure");
  });

  it("emits the exact severity markers while a console capture is installed", () => {
    setLogLevelMarkerCapture(true);
    const logger = createLogger("test");
    logger.log("hello world");
    logger.warn("something happened");
    logger.error("failure");
    expect(errorSpy).toHaveBeenCalledWith("\u0000fnlvl=info\u0000[test] hello world");
    expect(warnSpy).toHaveBeenCalledWith("\u0000fnlvl=warn\u0000[test] something happened");
    expect(errorSpy).toHaveBeenCalledWith("\u0000fnlvl=error\u0000[test] failure");
  });

  it("keeps log output off stdout", () => {
    const logger = createLogger("x");
    logger.log("a");
    logger.warn("b");
    logger.error("c");
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it("pre-built instances use correct prefixes", () => {
    schedulerLog.log("tick");
    expect(errorSpy).toHaveBeenCalledWith("[scheduler] tick");

    executorLog.log("run");
    expect(errorSpy).toHaveBeenCalledWith("[executor] run");

    planLog.log("spec");
    expect(errorSpy).toHaveBeenCalledWith("[plan] spec");

    mergerLog.log("merge");
    expect(errorSpy).toHaveBeenCalledWith("[merger] merge");

    worktreePoolLog.log("prune");
    expect(errorSpy).toHaveBeenCalledWith("[worktree-pool] prune");

    reviewerLog.log("review");
    expect(errorSpy).toHaveBeenCalledWith("[reviewer] review");

    remoteNodeLog.log("stream");
    expect(errorSpy).toHaveBeenCalledWith("[remote-node] stream");
  });

  it("pre-built instances still carry the info marker under the opt-in", () => {
    process.env.FUSION_LOG_SEVERITY_MARKERS = "true";
    schedulerLog.log("tick");
    expect(errorSpy).toHaveBeenCalledWith("\u0000fnlvl=info\u0000[scheduler] tick");
  });
});
