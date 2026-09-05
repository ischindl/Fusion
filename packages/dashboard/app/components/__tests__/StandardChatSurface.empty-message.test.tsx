import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StandardChatMessageItem, StandardStreamingMessage } from "../StandardChatSurface";
import type { ChatMessageInfo, ToolCallInfo } from "../../hooks/chatTypes";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

const baseMessage: ChatMessageInfo = {
  id: "msg-assistant-empty",
  sessionId: "session-1",
  role: "assistant",
  content: "",
  createdAt: "2026-07-10T00:00:00.000Z",
};

function renderMessage(overrides: Partial<ChatMessageInfo> = {}, forcePlain = false) {
  const message: ChatMessageInfo = { ...baseMessage, ...overrides };
  return render(
    <StandardChatMessageItem
      message={message}
      forcePlain={forcePlain}
      agentName="Assistant"
      hideAssistantIdentity={false}
      showAssistantModelTag={false}
      activeModelTag={null}
      activeModelProvider={null}
      activeSessionId="session-1"
    />,
  );
}

function expectNoPlaceholder() {
  expect(screen.queryByTestId("chat-message-empty")).not.toBeInTheDocument();
  expect(screen.queryByText("No message")).not.toBeInTheDocument();
}

describe("StandardChatSurface empty assistant messages", () => {
  afterEach(() => {
    cleanup();
  });

  it.each([
    { name: "empty markdown", content: "", forcePlain: false },
    { name: "empty plain", content: "", forcePlain: true },
    { name: "whitespace markdown", content: "   \n", forcePlain: false },
    { name: "whitespace plain", content: "   \n", forcePlain: true },
  ])("renders No message for $name assistant content", ({ content, forcePlain }) => {
    renderMessage({ content }, forcePlain);

    expect(screen.getByTestId("chat-message-empty")).toHaveTextContent("No message");
  });

  it("does not render the placeholder for populated assistant content", () => {
    renderMessage({ content: "Hello **there**" });

    expectNoPlaceholder();
    expect(screen.getByText("Hello")).toBeInTheDocument();
  });

  it("does not render the placeholder when tool calls are the assistant content", () => {
    const toolCalls: ToolCallInfo[] = [
      { toolName: "read_file", status: "completed", isError: false, result: "done" },
    ];
    renderMessage({ content: "", toolCalls });

    expectNoPlaceholder();
    expect(screen.getByText("read_file")).toBeInTheDocument();
  });

  it("does not render the placeholder when thinking output is present", () => {
    renderMessage({ content: "", thinkingOutput: "Reasoning through the request" });

    expectNoPlaceholder();
    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(screen.getByText("Reasoning through the request")).toBeInTheDocument();
  });

  it("does not render the placeholder when attachments are present", () => {
    renderMessage({
      content: "",
      attachments: [
        {
          id: "attachment-1",
          filename: "artifact.txt",
          originalName: "artifact.txt",
          mimeType: "text/plain",
          size: 12,
          createdAt: "2026-07-10T00:00:00.000Z",
        },
      ],
    });

    expectNoPlaceholder();
    expect(screen.getByTestId("chat-message-attachment")).toHaveTextContent("artifact.txt");
  });

  it("does not render the placeholder when failure info is present", () => {
    renderMessage({ content: "", failureInfo: { summary: "Provider failed" } });

    expectNoPlaceholder();
    expect(screen.getByText("Response failed")).toBeInTheDocument();
    expect(screen.getByText("Provider failed")).toBeInTheDocument();
  });

  it.each([
    { role: "user" as const, content: "" },
    { role: "system" as const, content: "" },
  ])("does not render the assistant placeholder for $role messages", ({ role, content }) => {
    renderMessage({ id: `msg-${role}`, role, content });

    expectNoPlaceholder();
  });

  it("keeps the streaming waiting state separate from the empty final-message placeholder", () => {
    render(
      <StandardStreamingMessage
        streamingText=""
        streamingThinking=""
        streamingToolCalls={[]}
        forcePlain={false}
        agentName="Assistant"
        hideAssistantIdentity={false}
        showAssistantModelTag={false}
        activeModelTag={null}
        activeModelProvider={null}
      />,
    );

    expect(screen.getByText("Working…")).toBeInTheDocument();
    expect(document.querySelector(".chat-message-content--waiting")).toBeInTheDocument();
    expectNoPlaceholder();
  });

  it("keeps the streaming thinking state separate from the empty final-message placeholder", () => {
    render(
      <StandardStreamingMessage
        streamingText=""
        streamingThinking="Thinking about it"
        streamingToolCalls={[]}
        forcePlain={false}
        agentName="Assistant"
        hideAssistantIdentity={false}
        showAssistantModelTag={false}
        activeModelTag={null}
        activeModelProvider={null}
      />,
    );

    expect(screen.getByText("Thinking…")).toBeInTheDocument();
    expect(screen.getByText("Thinking about it")).toBeInTheDocument();
    expectNoPlaceholder();
  });

  /*
  FNXC:ChatPhaseStatus 2026-09-05-10:23:
  RUFU-188: the empty waiting placeholder must expose a live `compacting` engine phase so a compaction wait
  reads "Working (compacting…)" instead of a bare "Working…". These cover the label's precedence and prove it
  is gated on the phase rather than merely always rendering — the phase decorates only the plain-working
  state (a streamed chain-of-thought keeps "Thinking…") and must never mask already-streamed answer text.

  FNXC:ChatPhaseStatus 2026-09-05-11:45:
  RUFU-188 (Code Review P2): the precedence assertions follow the spec contract `thinking > phase > working`
  restored in StandardChatSurface — the thinking disclosure is the more informative signal and a replayed
  stale `active: true` must not overpaint real thinking.
  */
  it("shows the compacting status while a live compacting phase is active", () => {
    render(
      <StandardStreamingMessage
        streamingText=""
        streamingThinking=""
        streamingToolCalls={[]}
        streamingPhase="compacting"
        forcePlain={false}
        agentName="Assistant"
        hideAssistantIdentity={false}
        showAssistantModelTag={false}
        activeModelTag={null}
        activeModelProvider={null}
      />,
    );

    expect(screen.getByText("Working (compacting…)")).toBeInTheDocument();
    expect(screen.queryByText("Working…")).not.toBeInTheDocument();
    expect(document.querySelector(".chat-message-content--waiting")).toBeInTheDocument();
  });

  it("keeps the thinking status ahead of a live compacting phase", () => {
    render(
      <StandardStreamingMessage
        streamingText=""
        streamingThinking="Thinking about it"
        streamingToolCalls={[]}
        streamingPhase="compacting"
        forcePlain={false}
        agentName="Assistant"
        hideAssistantIdentity={false}
        showAssistantModelTag={false}
        activeModelTag={null}
        activeModelProvider={null}
      />,
    );

    // Non-vacuous control: the same fixture minus thinking shows the compacting status (covered by the
    // case above), so the suppression here is the thinking disclosure, not the label being unreachable.
    expect(screen.getByText("Thinking…")).toBeInTheDocument();
    expect(screen.queryByText("Working (compacting…)")).not.toBeInTheDocument();
  });

  it("never masks already-streamed answer text when a compacting phase is reported", () => {
    render(
      <StandardStreamingMessage
        streamingText="Real answer"
        streamingThinking=""
        streamingToolCalls={[]}
        streamingPhase="compacting"
        forcePlain={false}
        agentName="Assistant"
        hideAssistantIdentity={false}
        showAssistantModelTag={false}
        activeModelTag={null}
        activeModelProvider={null}
      />,
    );

    expect(screen.getByText("Real answer")).toBeInTheDocument();
    expect(screen.queryByText("Working (compacting…)")).not.toBeInTheDocument();
  });
});
