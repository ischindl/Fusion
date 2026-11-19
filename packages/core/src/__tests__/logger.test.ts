import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLogger } from "../process/logger.js";
import { setLogLevelMarkerCapture } from "../process/log-severity-markers.js";

/*
FNXC:LogSeverityMarkers 2026-11-19-02:47 (RUFU-666):
Plain CLI stderr must stay byte-clean: NUL-wrapped severity markers made every `fn` run's
stderr binary to grep/pipes (false "board is empty" deductions). These cases pin the three
emission modes: default = marker-free payload on the same channels; env opt-in and capture
flag = the exact historical marker shape. Channel/severity semantics are unchanged.
*/

describe("core createLogger", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  const originalDebug = process.env.FUSION_DEBUG;
  const originalMarkers = process.env.FUSION_LOG_SEVERITY_MARKERS;

  beforeEach(() => {
    delete process.env.FUSION_DEBUG;
    delete process.env.FUSION_LOG_SEVERITY_MARKERS;
    setLogLevelMarkerCapture(false);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalDebug === undefined) delete process.env.FUSION_DEBUG;
    else process.env.FUSION_DEBUG = originalDebug;
    if (originalMarkers === undefined) delete process.env.FUSION_LOG_SEVERITY_MARKERS;
    else process.env.FUSION_LOG_SEVERITY_MARKERS = originalMarkers;
    setLogLevelMarkerCapture(false);
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("emits info logs to stderr without a severity marker by default", () => {
    const logger = createLogger("core-test");
    logger.log("hello");

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith("[core-test] hello");
    expect(errorSpy.mock.calls[0]?.[0]).not.toContain("\u0000");
  });

  it("emits warn logs marker-free by default", () => {
    const logger = createLogger("core-test");
    logger.warn("careful");

    expect(warnSpy).toHaveBeenCalledWith("[core-test] careful");
    expect(warnSpy.mock.calls[0]?.[0]).not.toContain("\u0000");
  });

  it("emits error logs marker-free by default", () => {
    const logger = createLogger("core-test");
    const err = new Error("boom");
    logger.error("broken", err);

    expect(errorSpy).toHaveBeenCalledWith("[core-test] broken", err);
    expect(errorSpy.mock.calls[0]?.[0]).not.toContain("\u0000");
  });

  it("prepends the exact severity markers when FUSION_LOG_SEVERITY_MARKERS is opted in", () => {
    process.env.FUSION_LOG_SEVERITY_MARKERS = "1";
    const logger = createLogger("core-test");
    logger.log("hello");
    logger.warn("careful");
    const err = new Error("boom");
    logger.error("broken", err);

    expect(errorSpy).toHaveBeenCalledWith("\u0000fnlvl=info\u0000[core-test] hello");
    expect(warnSpy).toHaveBeenCalledWith("\u0000fnlvl=warn\u0000[core-test] careful");
    expect(errorSpy).toHaveBeenCalledWith("\u0000fnlvl=error\u0000[core-test] broken", err);
  });

  it("prepends the exact severity markers while a console capture is installed", () => {
    setLogLevelMarkerCapture(true);
    const logger = createLogger("core-test");
    logger.log("hello");
    logger.warn("careful");

    expect(errorSpy).toHaveBeenCalledWith("\u0000fnlvl=info\u0000[core-test] hello");
    expect(warnSpy).toHaveBeenCalledWith("\u0000fnlvl=warn\u0000[core-test] careful");
  });

  /*
  FNXC:EngineDiagnostics 2026-07-26-09:45:
  process-supervisor spawn chatter depends on debug gating; lock the contract here so TUI spam cannot regress.
  */
  it("suppresses debug output when FUSION_DEBUG is unset", () => {
    const logger = createLogger("process-supervisor");
    logger.debug("spawned pid=123 pgid=123 command=pnpm test");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("emits debug when FUSION_DEBUG names the subsystem", () => {
    process.env.FUSION_DEBUG = "process-supervisor";
    const logger = createLogger("process-supervisor");
    logger.debug("spawned pid=123 pgid=123 command=pnpm test");
    expect(errorSpy).toHaveBeenCalledWith(
      "[process-supervisor] spawned pid=123 pgid=123 command=pnpm test",
    );
    expect(errorSpy.mock.calls[0]?.[0]).not.toContain("\u0000");
  });

  it("emits debug for every subsystem when FUSION_DEBUG=all", () => {
    process.env.FUSION_DEBUG = "all";
    const logger = createLogger("process-supervisor");
    logger.debug("child pid=123 exited naturally code=0 signal=null");
    expect(errorSpy).toHaveBeenCalled();
  });
});
