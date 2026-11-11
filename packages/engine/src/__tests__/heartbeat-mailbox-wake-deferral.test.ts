/*
FNXC:MailboxWakeDeferral 2026-11-11-08:43:
Acceptance for the durable-inbox wake deferral. The production shape this repairs: an `on-heartbeat`
recipient keeps its mail unread until a real heartbeat run consumes it, so with the board at live_exec=0 /
21 operator holds the unread set is permanent and every 1 s reconciliation pass re-delivered it — 100 883
`outcome=on-heartbeat` lines in one hour, the same messageId reconciled 1 663 times, one recipient read per
message per pass, against 7 messages arriving per 30 minutes.

The invariant is "a pass costs what it decides, not what the backlog contains", and it is asserted on every
surface that reaches the verdict, not only on the reported sweep:
  1. the durable reconciliation sweep (the measured flood),
  2. the same-process send hook (the other caller of the same verdict),
  3. the forced user wake, which must NEVER be swallowed by a remembered deferral,
  4. a persisted config/state edit, which must re-derive the verdict at once,
  5. a monitor restart, which must not inherit a verdict it never made.
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HeartbeatMonitor } from "../agent-heartbeat.js";
/* The monitor logs through the named `heartbeatLog` of `logger.js`, which the mock below makes one shared instance. */
import { heartbeatLog } from "../logger.js";
import type { AgentHeartbeatRun, AgentStore, Message, MessageStore } from "@fusion/core";
import { createMockStore, createMockMessageStore, createMessage } from "./heartbeat-test-helpers.js";

/*
 * One shared logger for every createLogger() call, because `agent-heartbeat.ts` builds its own
 * `heartbeatLog = createLogger("heartbeat")` at module load. The helper's default factory hands out a fresh
 * mock per call, which would silently make every log-count assertion below vacuously true.
 */
vi.mock("../logger.js", async () => {
  const { createMockLogger, formatMockError } = await import("./heartbeat-test-helpers.js");
  const shared = createMockLogger();
  return { createLogger: vi.fn(() => shared), heartbeatLog: shared, formatError: formatMockError };
});

/** Drives one reconciliation pass deterministically instead of waiting on the 1 s monitor interval. */
function reconcile(monitor: HeartbeatMonitor): Promise<void> {
  return (monitor as unknown as { reconcileUnreadMailboxWakes: () => Promise<void> }).reconcileUnreadMailboxWakes();
}

function countLogLines(needle: string): number {
  return vi.mocked(heartbeatLog.log).mock.calls.filter((call) => String(call[0]).includes(needle)).length;
}

type Fixture = {
  monitor: HeartbeatMonitor;
  configStore: AgentStore;
  getAgent: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.spyOn>;
  setInbox: (messages: Message[]) => void;
  setMode: (mode: string) => void;
  setState: (state: string) => void;
};

function createFixture(initialInbox: Message[], initialMode = "on-heartbeat"): Fixture {
  let inbox = initialInbox;
  let mode = initialMode;
  let state = "idle";
  const agentRow = () => ({ id: "agent-1", state, runtimeConfig: { messageResponseMode: mode } });
  const configStore = createMockStore({
    listAgents: vi.fn().mockResolvedValue([agentRow()]),
    getAgent: vi.fn().mockImplementation(async () => agentRow()),
  });
  const messageStore = createMockMessageStore() as MessageStore & { getInbox: ReturnType<typeof vi.fn> };
  messageStore.getInbox = vi.fn().mockImplementation(async () => inbox);
  const monitor = new HeartbeatMonitor({
    store: createMockStore(),
    agentStore: configStore,
    messageStore,
    pollIntervalMs: 3_600_000,
  });
  const execute = vi.spyOn(monitor, "executeHeartbeat").mockResolvedValue({ id: "run-1" } as AgentHeartbeatRun);
  return {
    monitor,
    configStore,
    getAgent: vi.mocked(configStore.getAgent!),
    execute,
    setInbox: (messages) => {
      inbox = messages;
    },
    setMode: (next) => {
      mode = next;
      vi.mocked(configStore.listAgents!).mockResolvedValue([agentRow()] as never);
    },
    setState: (next) => {
      state = next;
      vi.mocked(configStore.listAgents!).mockResolvedValue([agentRow()] as never);
    },
  };
}

let fixture: Fixture;

beforeEach(() => {
  // Fake timers own both the monitor's 1 s interval and Date.now, which the deferral summary is floored on.
  vi.useFakeTimers();
  vi.mocked(heartbeatLog.log).mockClear();
});

afterEach(() => {
  fixture?.monitor.stop();
  vi.useRealTimers();
});

describe("mailbox wake deferral", () => {
  /*
  FNXC:MailboxWakeDeferral 2026-11-11-10:29: the invariant the first shipped version missed. The deferral
  key hashed the raw `agent.state`, so the ordinary lifecycle of the recipient (a heartbeat run moving it
  idle -> running -> idle) evicted its own episode and the next pass re-decided and re-logged the whole
  backlog: 19 388 verdict lines in 60 minutes on the deployed engine, across 22 recipients, with zero
  `deferral-cap-reached`. A flip the verdict cannot see must cost nothing; a flip it does read must not be
  swallowed. Both halves are asserted, because a fix that only stopped logging would hide the second.
  */
  it("keeps a remembered verdict across every state flip an `on-heartbeat` verdict cannot read", async () => {
    fixture = createFixture([
      createMessage({ id: "mail-1", toId: "agent-1", toType: "agent" }),
      createMessage({ id: "mail-2", toId: "agent-1", toType: "agent" }),
    ]);
    fixture.monitor.start();
    await vi.advanceTimersByTimeAsync(50);
    await reconcile(fixture.monitor);
    expect(countLogLines("outcome=on-heartbeat")).toBe(2);

    // The lifecycle of a running heartbeat, then a park: the mode gate returns before the state gate, so no
    // flip below can change a `defer` verdict. Pre-fix each of these dropped the episode and re-log the
    // backlog on the following pass.
    for (const next of ["running", "active", "idle", "paused", "idle"] as const) {
      fixture.setState(next);
      await vi.advanceTimersByTimeAsync(61_000);
      await reconcile(fixture.monitor);
    }
    expect(countLogLines("outcome=on-heartbeat")).toBe(2);
    expect(countLogLines("outcome=ineligible-state")).toBe(0);
    // Remembering a deferral across those flips is still not waking.
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it("re-decides an `immediate` recipient the moment its eligibility class changes", async () => {
    /*
    The durable sweep skips `paused`/`error` recipients before the verdict, so the ineligible class is only
    reachable through the same-process send hook — asserted here rather than against the sweep, which cannot
    produce it. `AGENT_STATES` has five values and the sweep skips exactly the two the decision rejects.
    */
    let hook: ((message: Message) => void) | undefined;
    let state = "paused";
    const messageStore = createMockMessageStore((h) => {
      hook = h;
    }) as MessageStore & { getInbox: ReturnType<typeof vi.fn> };
    messageStore.getInbox = vi.fn().mockResolvedValue([]);
    const configStore = createMockStore({
      getAgent: vi.fn().mockImplementation(async () => ({
        id: "agent-1",
        state,
        runtimeConfig: { messageResponseMode: "immediate" },
      })),
    });
    const monitor = new HeartbeatMonitor({ store: createMockStore(), agentStore: configStore, messageStore });
    fixture = { monitor } as Fixture;
    const execute = vi.spyOn(monitor, "executeHeartbeat").mockResolvedValue({ id: "run-1" } as AgentHeartbeatRun);
    monitor.start();
    await vi.advanceTimersByTimeAsync(50);

    const message = createMessage({ id: "imm-mail", toId: "agent-1", toType: "agent" });
    hook?.(message);
    hook?.(message);
    await vi.advanceTimersByTimeAsync(50);
    // An immediate recipient that cannot be woken: told once, and the verdict remembered.
    expect(countLogLines("outcome=ineligible-state")).toBe(1);
    expect(execute).not.toHaveBeenCalled();

    // Becoming eligible is a different verdict and must fire at once, not wait for anything else to notice.
    state = "idle";
    hook?.(message);
    await vi.advanceTimersByTimeAsync(50);
    expect(execute).toHaveBeenCalled();
  });

  it("decides a deferred backlog once, not once per pass, on the durable sweep", async () => {
    fixture = createFixture([
      createMessage({ id: "mail-1", toId: "agent-1", toType: "agent" }),
      createMessage({ id: "mail-2", toId: "agent-1", toType: "agent" }),
      createMessage({ id: "mail-3", toId: "agent-1", toType: "agent" }),
    ]);
    fixture.monitor.start();
    await vi.advanceTimersByTimeAsync(50);

    // 61 simulated seconds ≈ 61 further passes over the same unread three rows. Pre-fix this is where the
    // production shape appeared: one verdict line per message per pass (~28 lines/s sustained).
    await vi.advanceTimersByTimeAsync(61_000);
    await reconcile(fixture.monitor);

    // Three deferred messages, one verdict line each — however many passes followed.
    expect(countLogLines("outcome=on-heartbeat")).toBe(3);
    // The backlog stays visible without per-message logging: one bounded summary per recipient.
    expect(countLogLines("outcome=deferred-backlog")).toBe(1);
    // Deferring is not waking: no heartbeat run was scheduled for mail the recipient must read itself.
    expect(fixture.execute).not.toHaveBeenCalled();
    // The sweep already holds the recipient row, so it must not re-read it per message per pass.
    expect(fixture.getAgent).not.toHaveBeenCalled();
  });

  it("still wakes a forced user wake sitting behind remembered deferrals", async () => {
    const ordinary = createMessage({ id: "ordinary", toId: "agent-1", toType: "agent" });
    fixture = createFixture([ordinary]);
    fixture.monitor.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(fixture.execute).not.toHaveBeenCalled();

    fixture.setInbox([
      ordinary,
      createMessage({
        id: "forced",
        toId: "agent-1",
        toType: "agent",
        metadata: { wakeRecipient: true, kind: "cli-chat" },
      }),
    ]);
    await reconcile(fixture.monitor);

    expect(fixture.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        triggerDetail: "wake-on-message-forced",
        wakeMessage: expect.objectContaining({ messageId: "forced", forced: true }),
      }),
    );
    // The already-deferred row beside it stays decided.
    expect(countLogLines("outcome=on-heartbeat")).toBe(1);
  });

  it("re-derives the verdict when the recipient's mode is edited to immediate", async () => {
    fixture = createFixture([createMessage({ id: "mail-1", toId: "agent-1", toType: "agent" })]);
    fixture.monitor.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(fixture.execute).not.toHaveBeenCalled();

    // No event is emitted here: the episode's own decision fingerprint has to catch the change.
    fixture.setMode("immediate");
    await reconcile(fixture.monitor);

    expect(fixture.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        triggerDetail: "wake-on-message",
        wakeMessage: expect.objectContaining({ messageId: "mail-1", forced: false }),
      }),
    );
  });

  it("does not carry remembered deferrals across a monitor restart", async () => {
    const messages = [createMessage({ id: "mail-1", toId: "agent-1", toType: "agent" })];
    fixture = createFixture(messages);
    fixture.monitor.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(countLogLines("outcome=on-heartbeat")).toBe(1);

    fixture.monitor.stop();
    fixture.monitor.start();
    await vi.advanceTimersByTimeAsync(50);
    await reconcile(fixture.monitor);

    // The new lifecycle reached its own verdict on the same row instead of trusting the old one.
    expect(countLogLines("outcome=on-heartbeat")).toBe(2);
  });

  it("defers once on the same-process send hook as well", async () => {
    let hook: ((message: Message) => void) | undefined;
    const messageStore = createMockMessageStore((h) => {
      hook = h;
    }) as MessageStore & { getInbox: ReturnType<typeof vi.fn> };
    messageStore.getInbox = vi.fn().mockResolvedValue([]);
    const configStore = createMockStore({
      getAgent: vi.fn().mockResolvedValue({ id: "agent-1", state: "idle", runtimeConfig: { messageResponseMode: "on-heartbeat" } }),
    });
    const monitor = new HeartbeatMonitor({ store: createMockStore(), agentStore: configStore, messageStore });
    fixture = { monitor } as Fixture;
    const execute = vi.spyOn(monitor, "executeHeartbeat").mockResolvedValue({ id: "run-1" } as AgentHeartbeatRun);
    monitor.start();
    await vi.advanceTimersByTimeAsync(50);

    const message = createMessage({ id: "hook-mail", toId: "agent-1", toType: "agent" });
    hook?.(message);
    hook?.(message);
    await vi.advanceTimersByTimeAsync(50);

    expect(countLogLines("outcome=on-heartbeat")).toBe(1);
    expect(execute).not.toHaveBeenCalled();
  });
});
