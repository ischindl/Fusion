import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as nodePty from "node-pty";

/*
FNXC:MemoryPressure 2026-09-21-23:05 (RUFU-257):
The two terminal delivery queues are the only per-session buffers that grew with output volume rather
than with a documented ceiling: `scrollbackBuffer` was already trimmed to MAX_SCROLLBACK_SIZE, while
`outputChunks` (drained on a 16 ms throttle) and `resizeSuppressedChunks` (moved into the delivery
queue when a 150 ms resize debounce fires) were unbounded. These cases are the spec's reproduction:
1 000 × 4 KiB chunks inside a resize-suppression window, and a burst larger than one throttle frame.
Both must stay inside their named ceilings and must count what they discard.
*/
import {
  MAX_SCROLLBACK_SIZE,
  getTerminalService,
  TerminalService,
  TERMINAL_OUTPUT_BYTES_MAX,
  TERMINAL_OUTPUT_CHUNKS_MAX,
  TERMINAL_RESIZE_SUPPRESSED_BYTES_MAX,
  TERMINAL_RESIZE_SUPPRESSED_CHUNKS_MAX,
  TERMINAL_SESSIONS_TRACKED_MAX,
  terminalOutputDropTotals,
  type TerminalSession,
} from "../terminal-service.js";
import { retentionCensusSnapshot } from "../lib/retention-census.js";

const { mockLoadPtyModule } = vi.hoisted(() => ({
  mockLoadPtyModule: vi.fn(),
}));

const mockPtyProcess = {
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
  onData: vi.fn((cb: (data: string) => void) => {
    mockPtyProcess._onDataCallback = cb;
    return { dispose: vi.fn() };
  }),
  onExit: vi.fn((cb: (e: { exitCode: number }) => void) => {
    mockPtyProcess._onExitCallback = cb;
    return { dispose: vi.fn() };
  }),
  _onDataCallback: null as ((data: string) => void) | null,
  _onExitCallback: null as ((e: { exitCode: number }) => void) | null,
};

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => mockPtyProcess),
}));

vi.mock("@fusion/engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/engine")>()),
  loadPtyModule: mockLoadPtyModule,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn().mockResolvedValue({ isDirectory: () => true }) };
});

/** PTY chunk size used by the spec reproduction. */
const CHUNK_CHARS = 4 * 1024;

describe("terminal-service buffer ceilings", () => {
  /*
   * The census rows are module-scope and read the per-root registry, so the fixture has to be built
   * through `getTerminalService` — a directly constructed service is invisible to the instrument,
   * which is exactly the reporting gap this task is closing.
   */
  const projectRoot = "/test/retention/project";
  let service: TerminalService;
  let session: TerminalSession;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockLoadPtyModule.mockResolvedValue(nodePty);
    vi.mocked(nodePty.spawn).mockImplementation(() => mockPtyProcess as never);
    mockPtyProcess._onDataCallback = null;
    service = getTerminalService(projectRoot, 10);
    service.cleanup();
    const created = await service.createSession();
    if (!created.success) {
      throw new Error(`session creation failed in fixture: ${created.error}`);
    }
    session = created.session;
  });

  afterEach(() => {
    service.cleanup();
    vi.restoreAllMocks();
  });

  function push(chunk: string): void {
    mockPtyProcess._onDataCallback?.(chunk);
  }

  /*
   * A fixed-size chunk that still says which push produced it. Padding keeps every chunk exactly
   * CHUNK_CHARS long so the byte ceiling's arithmetic stays predictable while the assertions check
   * WHICH chunks survived, not merely that the count is small.
   */
  function markerChunk(index: number, char: string): string {
    return `[${index}]`.padEnd(CHUNK_CHARS, char);
  }

  /*
   * RUFU-257 code review: `<= ceiling` plus `dropped > 0` is also satisfied by an implementation that
   * empties the whole queue, and that is exactly the defect the byte-counter desync caused. A bound
   * that discards the newest data or all of it is a broken bound, so every ceiling case asserts the
   * retained window is full-sized AND that its contents are the most recent pushes.
   */
  const retainedWindowChunks = Math.ceil(TERMINAL_OUTPUT_BYTES_MAX / CHUNK_CHARS);

  it("bounds the resize-suppressed queue in chunks and bytes while discarding the oldest", () => {
    // The suppression window: `resize()` holds PTY output until the 150 ms debounce fires.
    expect(service.resize(session.id, 120, 30, true)).toBe(true);

    for (let i = 0; i < 1_000; i++) {
      push(markerChunk(i, "r"));
    }

    expect(session.resizeSuppressedChunks.length).toBeLessThanOrEqual(TERMINAL_RESIZE_SUPPRESSED_CHUNKS_MAX);
    expect(session.resizeSuppressedBytes).toBeLessThanOrEqual(TERMINAL_RESIZE_SUPPRESSED_BYTES_MAX);
    // The byte ceiling is what binds at a real ~4 KiB chunk size, so the queue holds a full byte
    // window of the NEWEST output — not zero chunks (the over-drop defect) and not all 1 000.
    expect(session.resizeSuppressedChunks.length).toBe(retainedWindowChunks);
    expect(session.resizeSuppressedChunks.at(-1)!.startsWith("[999]")).toBe(true);
    expect(session.resizeSuppressedChunks[0].startsWith(`[${1_000 - retainedWindowChunks}]`)).toBe(true);
    // Retention without observability is silent stream loss: the drops must be counted.
    expect(session.droppedResizeSuppressedChunks).toBeGreaterThan(0);
    expect(terminalOutputDropTotals().resizeSuppressedChunks).toBeGreaterThanOrEqual(
      session.droppedResizeSuppressedChunks,
    );
  });

  it("bounds the delivery queue below one throttle frame's worth of output", () => {
    // A burst larger than the 16 ms flush can schedule: no flush timer has fired yet.
    for (let i = 0; i < 200; i++) {
      push(markerChunk(i, "o"));
    }

    expect(session.outputChunks.length).toBeLessThanOrEqual(TERMINAL_OUTPUT_CHUNKS_MAX);
    expect(session.outputBytes).toBeLessThanOrEqual(TERMINAL_OUTPUT_BYTES_MAX);
    // Same invariant as the resize case: trimming to the byte ceiling keeps the newest `ceil(bytes /
    // chunk)` chunks and discards only older ones, so the client still receives the current prompt.
    expect(session.outputChunks.length).toBe(retainedWindowChunks);
    expect(session.outputChunks.at(-1)!.startsWith("[199]")).toBe(true);
    expect(session.outputChunks[0].startsWith(`[${200 - retainedWindowChunks}]`)).toBe(true);
    expect(session.droppedOutputChunks).toBeGreaterThan(0);
    expect(session.droppedOutputBytes).toBeGreaterThan(0);
  });

  it("counts every discard through one cumulative accessor", () => {
    const before = terminalOutputDropTotals();

    for (let i = 0; i < 200; i++) {
      push("x".repeat(CHUNK_CHARS));
    }

    const after = terminalOutputDropTotals();
    expect(after.outputChunks).toBe(before.outputChunks + session.droppedOutputChunks);
    expect(after.outputBytes).toBe(before.outputBytes + session.droppedOutputBytes);
  });

  it("reports the queue through the census in one unit (sessions tracked, pending bytes)", () => {
    for (let i = 0; i < 20; i++) {
      push("c".repeat(CHUNK_CHARS));
    }

    const sources = retentionCensusSnapshot().sources;
    const buffers = sources.find((source) => source.id === "terminal_output_buffers");
    const registry = sources.find((source) => source.id === "terminal_service_registry");

    expect(buffers).toBeDefined();
    expect(registry).toBeDefined();
    // Entries are sessions and the ceiling is a session count, so `atCeiling` stays meaningful.
    expect(buffers!.entries).toBeGreaterThanOrEqual(1);
    expect(buffers!.entries).toBeLessThanOrEqual(TERMINAL_SESSIONS_TRACKED_MAX);
    expect(buffers!.approxBytes).toBeGreaterThan(0);
    // A queue with no expiry semantics never reports entries held past their expiry.
    expect(buffers!.expiredEntries).toBe(0);
    expect(registry!.entries).toBeGreaterThanOrEqual(1);
  });

  it("keeps the already-bounded scrollback trim in place", () => {
    for (let i = 0; i < 40; i++) {
      push("s".repeat(2 * 1024));
    }

    expect(MAX_SCROLLBACK_SIZE).toBe(50_000);
    expect(session.scrollbackBuffer.length).toBeLessThanOrEqual(MAX_SCROLLBACK_SIZE);
  });
});
