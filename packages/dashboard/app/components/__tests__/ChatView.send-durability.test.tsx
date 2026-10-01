import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ChatView } from "../ChatView";
import type { ChatSendCallbacks } from "../../hooks/useChat";
import {
  activeSessionFixture,
  installChatViewEnv,
  mockRevokeObjectURL,
  renderChatDetailWithAct,
  setupMockChat,
} from "./ChatView.test-harness";

/*
FNXC:ChatSendDurability 2026-09-07-13:10:
RUFU-192 — the operator lost three prompts across two projects: Enter pressed, no transcript row,
no error, no stored draft. Root cause was destructive ordering: `handleSend` emptied the composer
and its draft key BEFORE a request existed, so every failure short of the server's user-row write
destroyed the text with no owner left. These tests pin the replacement contract — the composer is
destroyed only at a durability hand-off (the `user_persisted` ack or the persisted pending-FIFO
row), every failure path hands the text back, and every refusal speaks. Each case names the
pre-fix condition it proves gone, so a green run here is evidence about the incident and not
about ChatView's general rendering.
*/

const mocks = vi.hoisted(() => ({
  fetchGlobalSettings: vi.fn(),
  updateGlobalSettings: vi.fn(),
  addSteeringComment: vi.fn(),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
}));

/*
FNXC:ChatSendDurability 2026-09-07-15:00:
The real CustomModelDropdown is a focus-trapped combobox portal; for the only test that needs a
real model→model switch it is reduced to one button per model that reports the same
"provider/model" value the real onChange emits. The dropdown is not rendered on the agent-mode
path nor opened by any other test in this file, so this mock has no other blast radius.
*/
vi.mock("../CustomModelDropdown", async () => {
  const React = await import("react");
  return {
    CustomModelDropdown: (props: { models?: Array<{ provider: string; id: string }>; onChange?: (value: string) => void }) =>
      React.createElement(
        "div",
        null,
        (props.models ?? []).map((model) =>
          React.createElement(
            "button",
            {
              key: `${model.provider}/${model.id}`,
              type: "button",
              "data-testid": `model-option-${model.provider}/${model.id}`,
              onClick: () => props.onChange?.(`${model.provider}/${model.id}`),
            },
            `${model.provider}/${model.id}`,
          ),
        ),
      ),
  };
});

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return { ...actual, useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }) };
});
vi.mock("../../api", () => ({
  fetchSettings: vi.fn().mockResolvedValue({}),
  fetchModels: mocks.fetchModels,
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchGlobalSettings: mocks.fetchGlobalSettings,
  updateGlobalSettings: mocks.updateGlobalSettings,
  fetchTasks: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
  addSteeringComment: mocks.addSteeringComment,
  fetchChatSession: vi.fn().mockResolvedValue({ session: { memoryFocus: null } }),
}));

installChatViewEnv();

const DRAFT_KEY = `fusion:chat-draft:direct:${activeSessionFixture.id}`;

function composer(): HTMLTextAreaElement {
  return screen.getByTestId("chat-input");
}

function draftValue(): string | null {
  return localStorage.getItem(DRAFT_KEY);
}

/** Mount ChatView on an open conversation whose `sendMessage` captures the durability callbacks. */
async function mountChat(options: {
  addToast?: ReturnType<typeof vi.fn>;
  floating?: boolean;
  sendMessage?: ReturnType<typeof vi.fn>;
  commandContext?: { taskId: string; projectId: string; agentRunning: boolean };
} = {}) {
  const addToast = options.addToast ?? vi.fn();
  mocks.fetchGlobalSettings.mockResolvedValue({});
  mocks.updateGlobalSettings.mockResolvedValue({});
  const captures: ChatSendCallbacks[] = [];
  const sendMessage =
    options.sendMessage ??
    vi.fn((_content: string, _files?: File[], callbacks?: ChatSendCallbacks) => {
      captures.push(callbacks ?? {});
    });
  setupMockChat({ activeSession: activeSessionFixture, messages: [], sendMessage });
  await renderChatDetailWithAct(
    <ChatView
      projectId="proj-123"
      addToast={addToast}
      floating={options.floating ?? false}
      chatCommandContext={options.commandContext}
    />,
  );
  return {
    addToast,
    sendMessage,
    /** The callbacks of the most recent submit — the same object the stream drives. */
    latest: () => driven(captures[captures.length - 1] ?? {}),
    sendCount: () => captures.length,
  };
}

/** Type a prompt through the real composer and submit it with Enter. */
async function submitPrompt(prompt: string, options: Parameters<typeof mountChat>[0] = {}) {
  const chat = await mountChat(options);
  await userEvent.type(composer(), prompt);
  fireEvent.keyDown(composer(), { key: "Enter" });
  return chat;
}

/*
FNXC:ChatSendDurability 2026-09-07-15:15:
Driving a durability callback is how the SSE stream commits the composer, so the test drives it
through `act` — a callback fired bare would settle outside React's flush and leave the assertions
below racing the render instead of reading its result.
*/
function driven(send: ChatSendCallbacks): ChatSendCallbacks {
  const wrap = <A extends unknown[]>(fn?: (...args: A) => void) =>
    fn
      ? (...args: A) => {
          act(() => {
            fn(...args);
          });
        }
      : undefined;
  return {
    onAccepted: wrap(send.onAccepted),
    onPersisted: wrap(send.onPersisted),
    onQueued: wrap(send.onQueued),
    onDelivered: wrap(send.onDelivered),
    onFailed: wrap(send.onFailed),
  };
}

describe("ChatView send durability (RUFU-192)", () => {
  it("keeps an unacknowledged prompt in the composer when the request never reports back (defect 3)", async () => {
    // Pre-fix: `setMessageInput("")` ran before `sendMessage()`, so a send that never reported
    // back (offline, aborted, dead proxy) left an empty composer and no record anywhere.
    const chat = await mountChat();
    await userEvent.type(composer(), "restore me after a silent failure");
    fireEvent.keyDown(composer(), { key: "Enter" });

    expect(chat.sendCount()).toBe(1);
    expect(composer()).toHaveValue("restore me after a silent failure");
    await waitFor(() => expect(draftValue()).toBe("restore me after a silent failure"));
  });

  it("clears the composer and its draft key exactly at the persisted acknowledgement", async () => {
    // The `user_persisted` ack is the only positive proof the row was stored — `res.ok` precedes
    // the write — so it, not acceptance, is the commit point.
    const chat = await submitPrompt("prompt the server stored");
    const { onAccepted, onPersisted } = chat.latest();

    onAccepted?.();
    expect(composer()).toHaveValue("prompt the server stored");

    onPersisted?.(true, "msg-persisted-1");
    await waitFor(() => expect(composer()).toHaveValue(""));
    await waitFor(() => expect(draftValue()).toBeNull());
  });

  it("survives a duplicate acknowledgement and a same-tick completion", async () => {
    // SSE replay via Last-Event-ID can redeliver the ack and `done` can land in the same tick, so
    // the commit must be idempotent rather than restoring or re-clearing the draft.
    const chat = await submitPrompt("ack delivered twice");
    const send = chat.latest();

    // Control: pre-fix this text was already gone before any ack existed.
    expect(composer()).toHaveValue("ack delivered twice");

    send.onPersisted?.(true, "msg-a");
    send.onPersisted?.(true, "msg-a");
    send.onDelivered?.();

    await waitFor(() => expect(composer()).toHaveValue(""));
    expect(draftValue()).toBeNull();
  });

  it("hands the prompt to the queue hand-off, leaving exactly one durable owner", async () => {
    // Pre-fix a queued send left the composer, the draft key AND the FIFO row holding the same
    // text forever. The FIFO row is the owner from here (its single-row invariant is asserted in
    // useChat.test.ts), so the composer and its draft key must both go.
    const chat = await submitPrompt("prompt handed to the queue");

    // Control: the queue hand-off must be the moment of destruction, not the submit.
    expect(composer()).toHaveValue("prompt handed to the queue");

    chat.latest().onQueued?.();

    await waitFor(() => expect(composer()).toHaveValue(""));
    await waitFor(() => expect(draftValue()).toBeNull());
  });

  it("does not clear the composer on completion alone, because a lost ack is not proof of storage", async () => {
    // `done` without `onPersisted(true)` must keep the visible text: the hook never re-sends a
    // delivered turn, so at worst the operator deletes a survivor instead of losing a prompt.
    const chat = await submitPrompt("prompt whose ack frame was lost");

    chat.latest().onDelivered?.();

    expect(composer()).toHaveValue("prompt whose ack frame was lost");
    expect(draftValue()).toBe("prompt whose ack frame was lost");
  });

  it("does not clear the composer on a rejection that never reached the server", async () => {
    const chat = await submitPrompt("prompt that was never accepted");

    chat.latest().onFailed?.();

    expect(composer()).toHaveValue("prompt that was never accepted");
  });

  it("hands the first prompt back beside the newer attempt on failure (defect 4)", async () => {
    // Pre-fix: `onFailed` restored with `current || trimmed`, so attempt two replaced attempt one
    // outright and only one of the two prompts ever existed again.
    const chat = await submitPrompt("first attempt prompt");
    const input = composer();
    await userEvent.clear(input);
    await userEvent.type(input, "second attempt prompt");

    chat.latest().onFailed?.();

    await waitFor(() => expect(input).toHaveValue("second attempt prompt\nfirst attempt prompt"));
    await waitFor(() => expect(draftValue()).toBe("second attempt prompt\nfirst attempt prompt"));
  });

  it("restores the prompt when the turn was accepted but the user row was never stored", async () => {
    // `onPersisted(false)` means the stream ended without ever proving the row; a composer the
    // operator replaced in the meantime receives it appended, not clobbered.
    const chat = await submitPrompt("prompt whose row failed");
    const input = composer();
    await userEvent.clear(input);
    await userEvent.type(input, "unrelated new thought");

    chat.latest().onPersisted?.(false);

    await waitFor(() => expect(input).toHaveValue("unrelated new thought\nprompt whose row failed"));
  });

  it("restores the prompt when the send throws synchronously and says so", async () => {
    const chat = await mountChat({
      sendMessage: vi.fn(() => {
        throw new Error("runtime gone");
      }),
    });
    await userEvent.type(composer(), "prompt whose dispatch throws");
    fireEvent.keyDown(composer(), { key: "Enter" });

    expect(composer()).toHaveValue("prompt whose dispatch throws");
    expect(chat.addToast).toHaveBeenCalledWith("Failed to send message", "error");
  });

  it("refuses to re-submit a still-visible unacknowledged prompt (defect 1/2 consequence)", async () => {
    // Pre-fix: text-only Enter fell through to the FIFO append while the same text still sat in
    // the composer, so one prompt became two persisted turns with two durable owners.
    const chat = await submitPrompt("one and only copy");
    const addToast = chat.addToast;

    fireEvent.keyDown(composer(), { key: "Enter" });

    expect(chat.sendCount()).toBe(1);
    expect(addToast).toHaveBeenCalledWith(
      expect.stringContaining("still being delivered"),
      expect.any(String),
    );
    expect(composer()).toHaveValue("one and only copy");
  });

  it("lets a prompt through once the operator has removed the claimed text", async () => {
    // A prose edit that drops the in-flight text is a new prompt: the claim clears so a deliberate
    // retype is a fresh submission instead of a permanent false refusal.
    const chat = await submitPrompt("original claim text");
    const input = composer();
    // Control: the unacknowledged text is still owned by the composer at this point.
    expect(input).toHaveValue("original claim text");
    await userEvent.clear(input);
    await userEvent.type(input, "brand new text");

    fireEvent.keyDown(input, { key: "Enter" });

    expect(chat.addToast).not.toHaveBeenCalled();
    expect(chat.sendCount()).toBe(2);
  });

  it("keeps text typed during an in-flight send when the acknowledgement lands (FUX-015)", async () => {
    // An unconditional clear at commit time is the FUX-015 wipe race this repo was burned by once
    // already, so the commit removes only the submitted span.
    const chat = await submitPrompt("SUBMITTED");
    const input = composer();
    await userEvent.type(input, " ADDED MID-FLIGHT");
    expect(input).toHaveValue("SUBMITTED ADDED MID-FLIGHT");

    chat.latest().onPersisted?.(true, "msg-persisted-2");

    await waitFor(() => expect(input).toHaveValue(" ADDED MID-FLIGHT"));
    await waitFor(() => expect(draftValue()).toBe(" ADDED MID-FLIGHT"));
  });

  it("discards a draft the server already stored instead of re-offering it after a reload (defect 8)", async () => {
    // The ack-never-arrived race: the row exists but the draft key survived, and restoring it
    // would make the operator's next Enter persist the same turn a second time.
    const storedPrompt = "prompt already in the transcript";
    localStorage.setItem(DRAFT_KEY, storedPrompt);
    setupMockChat({
      activeSession: activeSessionFixture,
      messages: [
        { id: "msg-user-1", role: "user", content: storedPrompt, createdAt: "2026-09-07T08:00:00.000Z" },
        { id: "msg-assistant-1", role: "assistant", content: "answered", createdAt: "2026-09-07T08:00:05.000Z" },
      ],
    });
    await renderChatDetailWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await waitFor(() => expect(composer()).toHaveValue(""));
    await waitFor(() => expect(draftValue()).toBeNull());
  });

  it("never mistakes an unacknowledged optimistic bubble for proof of storage", async () => {
    // A local bubble is the opposite of durability: clearing a draft against one would recreate
    // the destructive-before-durable loss this suite exists to prevent.
    const typedPrompt = "prompt still only optimistic";
    localStorage.setItem(DRAFT_KEY, typedPrompt);
    setupMockChat({
      activeSession: activeSessionFixture,
      messages: [
        { id: "temp-user-1", role: "user", content: typedPrompt, createdAt: "2026-09-07T08:00:00.000Z" },
      ],
    });
    await renderChatDetailWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(composer()).toHaveValue(typedPrompt);
    expect(draftValue()).toBe(typedPrompt);
  });

  it("puts the text back when a slash command rejects (silent-exit sweep)", async () => {
    // `/steer` keeps its pre-round-trip clear to preserve the FUX-015 wipe-race proof, so the
    // rejected command must hand the prompt back instead of destroying it.
    mocks.addSteeringComment.mockRejectedValueOnce(new Error("steer lane refused"));
    const chat = await mountChat({
      commandContext: { taskId: "TASK-1", projectId: "proj-123", agentRunning: true },
    });
    const input = composer();
    fireEvent.change(input, { target: { value: "/steer keep this prompt" } });

    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(input).toHaveValue("/steer keep this prompt"));
    expect(chat.addToast).toHaveBeenCalledWith("steer lane refused", "error");
  });

  it("releases staged attachments at the persisted commit, not at acceptance", async () => {
    // Pre-fix previews left on `onAccepted` (res.ok), so an accepted-then-rejected turn lost its
    // text AND its files; release now waits for the durability hand-off.
    const chat = await mountChat();
    // An image gets a preview URL (text files deliberately get none), so this also proves the
    // blob URL is revoked at the hand-off rather than leaked.
    const file = new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" });
    await userEvent.upload(screen.getByTestId("chat-file-input"), file);
    fireEvent.keyDown(composer(), { key: "Enter" });

    expect(chat.sendMessage).toHaveBeenCalledWith("", [file], expect.any(Object));
    expect(screen.getByTestId("chat-attachment-preview-0")).toBeInTheDocument();

    chat.latest().onAccepted?.();
    expect(screen.getByTestId("chat-attachment-preview-0")).toBeInTheDocument();

    chat.latest().onPersisted?.(true, "msg-with-file-1");
    await waitFor(() => expect(screen.queryByTestId("chat-attachment-preview-0")).not.toBeInTheDocument());
    expect(mockRevokeObjectURL).toHaveBeenCalledWith("blob:shot.png");
  });

  it("applies the same commit point on a compact floating host", async () => {
    // Same handler, different host: the floating/dock shell must inherit the durability contract.
    const chat = await submitPrompt("floating host prompt", { floating: true });
    expect(composer()).toHaveValue("floating host prompt");

    chat.latest().onPersisted?.(true, "msg-floating-1");

    await waitFor(() => expect(composer()).toHaveValue(""));
    await waitFor(() => expect(draftValue()).toBeNull());
  });

  /*
  FNXC:ChatSendDurability 2026-09-07-16:40:
  Premise drift, recorded honestly: the diagnosis says a session-less composer "stays live", so
  Enter vanishes silently. List-first navigation (FN-054) since then renders the composer only
  inside an opened conversation, so today a session-less submit cannot even be typed — the refusal
  toast in handleSend is defence-in-depth for the states that can still reach it (a host that
  mounts a composer before the session resolves). What IS observable from the operator's incident
  — the text must not vanish — is asserted by the reload/reconciliation cases above, and the
  session-less draft half by the orphan-draft cases added in the following RUFU-192 step.
  */
  it("offers no submit at all while no session is resolved", async () => {
    const sendMessage = vi.fn();
    setupMockChat({ activeSession: null, sendMessage });
    await renderChatDetailWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.queryByTestId("chat-input")).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  /*
  FNXC:ChatSendDurability 2026-09-07-14:45:
  RUFU-192 defect 2 — the orphan draft. Honest scope note: list-first navigation (FN-054) renders
  the composer ONLY for a resolved session (`{activeSession && renderSessionComposerPane()}`), so a
  session-less composer is not currently reachable to type into. The orphan key is still the fix for
  the half of defect 2 that IS reachable: keystrokes typed while a session is open have to survive
  the gap when that session disappears (deletion, failed default-session creation, a switch that
  clears the thread), and the spec requires a draft to have a durable home and at most one owner at
  a time. So the orphan key is the project-scoped parking spot, and adoption is the moment it gets
  a owner again — which must merge rather than replace, because discarding either side is the loss
  this task exists to prevent.
  */
  const ORPHAN_KEY = "fusion:chat-draft:orphan:proj-123";

  it("adopts the orphan draft into the session key once a conversation exists", async () => {
    // Pre-fix the text typed before a conversation existed had no key at all, so it was simply
    // never stored; here it is durable and becomes visible the moment a session appears.
    localStorage.setItem(ORPHAN_KEY, "orphaned prompt awaiting a conversation");
    setupMockChat({ activeSession: activeSessionFixture, messages: [] });
    await renderChatDetailWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await waitFor(() => expect(composer()).toHaveValue("orphaned prompt awaiting a conversation"));
    await waitFor(() => expect(draftValue()).toBe("orphaned prompt awaiting a conversation"));
    // Adoption moves, it does not copy: the orphan key must not survive to be re-offered later.
    await waitFor(() => expect(localStorage.getItem(ORPHAN_KEY)).toBeNull());
  });

  it("keeps BOTH texts when the session already holds its own draft", async () => {
    // The invariant forbids discarding either side of an adoption, so both survive newline-joined.
    localStorage.setItem(ORPHAN_KEY, "orphan half");
    localStorage.setItem(DRAFT_KEY, "session half");
    setupMockChat({ activeSession: activeSessionFixture, messages: [] });
    await renderChatDetailWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await waitFor(() => expect(draftValue()).toBe("session half\norphan half"));
    await waitFor(() => expect(composer()).toHaveValue("session half\norphan half"));
    expect(localStorage.getItem(ORPHAN_KEY)).toBeNull();
  });

  it("collapses an adoption when both keys hold the same text", async () => {
    localStorage.setItem(ORPHAN_KEY, "same prompt typed twice");
    localStorage.setItem(DRAFT_KEY, "same prompt typed twice");
    setupMockChat({ activeSession: activeSessionFixture, messages: [] });
    await renderChatDetailWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await waitFor(() => expect(draftValue()).toBe("same prompt typed twice"));
    expect(composer()).toHaveValue("same prompt typed twice");
  });

  it("never adopts another project's orphan draft", async () => {
    // Orphan keys are project-scoped precisely so text typed in one project cannot be re-offered
    // inside another; the project's own orphan key simply reads empty here.
    localStorage.setItem("fusion:chat-draft:orphan:other-project", "private to another project");
    setupMockChat({ activeSession: activeSessionFixture, messages: [] });
    await renderChatDetailWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(composer()).toHaveValue("");
    expect(localStorage.getItem("fusion:chat-draft:orphan:other-project")).toBe("private to another project");
  });

  it("keeps the composer's storage on the orphan key while no session key exists", async () => {
    /*
    FNXC:ChatSendDurability 2026-09-07-15:20:
    Premise drift, recorded honestly: list-first navigation (FN-054) gates the composer itself on a
    resolved session (`{activeSession && renderSessionComposerPane()}`), so the diagnosis's
    "composer stays live with no session" state is no longer reachable to TYPE in — the visible
    half of defect 1 is already closed by that gate, which is why the case above asserts that no
    submit is offered. What this step therefore owns is the durability of the key itself: the
    persistence/restore effects now run against the orphan key whenever no session key exists, and
    adoption is what hands that parked text back. The adoption cases below are the observable proof;
    a session-less keystroke has no reachable UI to be typed through today.
    */
    setupMockChat({ activeSession: null, sessions: [], filteredSessions: [], messages: [], sendMessage: vi.fn() });
    await renderChatDetailWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.queryByTestId("chat-input")).toBeNull();
    // The orphan key must not be written or cleared by a mount that has no composer at all.
    expect(localStorage.getItem(ORPHAN_KEY)).toBeNull();
  });

  it("clears the orphan key as well as the session key on a successful commit", async () => {
    // A committed turn must not leave a second owner behind under either key.
    const captures: ChatSendCallbacks[] = [];
    localStorage.setItem(ORPHAN_KEY, "adopted then sent");
    setupMockChat({
      activeSession: activeSessionFixture,
      messages: [],
      sendMessage: vi.fn((_content: string, _files?: File[], callbacks?: ChatSendCallbacks) => {
        captures.push(callbacks ?? {});
      }),
    });
    await renderChatDetailWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    await waitFor(() => expect(composer()).toHaveValue("adopted then sent"));

    fireEvent.keyDown(composer(), { key: "Enter" });
    await waitFor(() => expect(captures).toHaveLength(1));
    act(() => {
      captures[0]?.onPersisted?.(true, "msg-adopted-1");
    });

    await waitFor(() => expect(composer()).toHaveValue(""));
    await waitFor(() => {
      expect(draftValue()).toBeNull();
      expect(localStorage.getItem(ORPHAN_KEY)).toBeNull();
    });
  });
});

/*
FNXC:ChatSendDurability 2026-09-07-14:50:
RUFU-192 Step 5: an agent-target chat reads its own pi session file while a model-target chat is
built from the persisted chat_messages rows, so switching a conversation onto an agent genuinely
does not carry the prior transcript. The operator hit that as unexplained amnesia ("it didn't
remember and the prompt was completely lost"), so the switch now says so before the PATCH. These
cases pin the disclosure to the one crossing that loses context — INTO an agent target on a thread
that already has messages — and prove it stays silent on an agent-to-agent retarget (different
brain, same context source) and on any switch when nothing precedes it. Each is a real click
through the target control, not a call into the handler, so the affordance and the guard are
gated together.
*/
const FN_MODEL_TARGET = "__fn_agent__";
const AGENT_NOTICE = "keeps its own conversation context";

function priorMessageFixture() {
  return {
    id: "msg-prior",
    sessionId: activeSessionFixture.id,
    role: "user",
    content: "what did we already discuss?",
    thinkingOutput: null,
    metadata: null,
    createdAt: "2026-04-08T00:00:00.000Z",
  } as never;
}

function agentTargetMap(agentIds: string[]): Map<string, never> {
  return new Map(agentIds.map((id) => [id, { id, name: id, role: "executor", state: "idle" } as never]));
}

/** Open a conversation with a chosen target, a prior turn, and the given selectable agents. */
async function mountTargetChat(options: {
  agentId: string;
  agents: string[];
  setSessionModel: ReturnType<typeof vi.fn>;
  messages?: unknown[];
  modelProvider?: string | null;
  modelId?: string | null;
}) {
  const addToast = vi.fn();
  const activeSession = {
    ...activeSessionFixture,
    agentId: options.agentId,
    modelProvider: options.modelProvider ?? null,
    modelId: options.modelId ?? null,
  };
  setupMockChat({
    activeSession,
    messages: (options.messages ?? [priorMessageFixture()]) as never,
    agentsMap: agentTargetMap(options.agents),
    setSessionModel: options.setSessionModel,
  });
  await renderChatDetailWithAct(<ChatView projectId="proj-123" addToast={addToast} />);
  return { addToast };
}

describe("ChatView target switch disclosure (RUFU-192 Step 5)", () => {
  it("discloses the transcript loss when a populated thread is switched onto an agent target", async () => {
    const setSessionModel = vi.fn().mockResolvedValue(undefined);
    const { addToast } = await mountTargetChat({
      agentId: FN_MODEL_TARGET,
      agents: ["agent-001"],
      setSessionModel,
    });

    // Pre-fix condition proven gone: an operator could retarget onto an agent and only discover
    // the amnesia in the next reply — no notice existed at switch time.
    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    fireEvent.click(screen.getByTestId("chat-thinking-mode-agent"));
    fireEvent.click(screen.getByTestId("chat-thinking-agent-agent-001"));

    expect(addToast).toHaveBeenCalledWith(expect.stringContaining(AGENT_NOTICE), "warning");
    expect(setSessionModel).toHaveBeenCalledWith(activeSessionFixture.id, { agentId: "agent-001" });
  });

  it("stays silent on an agent-to-agent retarget (same context source, different brain)", async () => {
    const setSessionModel = vi.fn().mockResolvedValue(undefined);
    const { addToast } = await mountTargetChat({
      agentId: "agent-001",
      agents: ["agent-001", "agent-002"],
      setSessionModel,
    });

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    fireEvent.click(screen.getByTestId("chat-thinking-mode-agent"));
    fireEvent.click(screen.getByTestId("chat-thinking-agent-agent-002"));

    expect(setSessionModel).toHaveBeenCalledWith(activeSessionFixture.id, { agentId: "agent-002" });
    expect(addToast).not.toHaveBeenCalledWith(expect.stringContaining(AGENT_NOTICE), expect.anything());
  });

  it("stays silent when the thread is empty because there is no transcript to lose", async () => {
    const setSessionModel = vi.fn().mockResolvedValue(undefined);
    const { addToast } = await mountTargetChat({
      agentId: FN_MODEL_TARGET,
      agents: ["agent-001"],
      setSessionModel,
      messages: [],
    });

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    fireEvent.click(screen.getByTestId("chat-thinking-mode-agent"));
    fireEvent.click(screen.getByTestId("chat-thinking-agent-agent-001"));

    expect(setSessionModel).toHaveBeenCalledWith(activeSessionFixture.id, { agentId: "agent-001" });
    expect(addToast).not.toHaveBeenCalledWith(expect.stringContaining(AGENT_NOTICE), expect.anything());
  });

  it("stays silent on a model→model switch (the transcript source does not change)", async () => {
    // This is the other conjunct of the guard: the notice is keyed on the NEW target being an
    // agent, not on a target change happening at all. A model→model switch changes the brain but
    // keeps the same chat_messages transcript, so it must not warn.
    const setSessionModel = vi.fn().mockResolvedValue(undefined);
    mocks.fetchModels.mockResolvedValue({
      models: [
        { provider: "anthropic", id: "claude-sonnet-4-5", label: "Claude" },
        { provider: "openai", id: "gpt-4o", label: "GPT-4o" },
      ],
      favoriteProviders: [],
      favoriteModels: [],
    });
    const { addToast } = await mountTargetChat({
      agentId: FN_MODEL_TARGET,
      agents: ["agent-001"],
      setSessionModel,
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    await waitFor(() => expect(screen.getByTestId("model-option-openai/gpt-4o")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("model-option-openai/gpt-4o"));

    await waitFor(() =>
      expect(setSessionModel).toHaveBeenCalledWith(activeSessionFixture.id, { modelProvider: "openai", modelId: "gpt-4o" }),
    );
    expect(addToast).not.toHaveBeenCalledWith(expect.stringContaining(AGENT_NOTICE), expect.anything());
    mocks.fetchModels.mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] });
  });
});
