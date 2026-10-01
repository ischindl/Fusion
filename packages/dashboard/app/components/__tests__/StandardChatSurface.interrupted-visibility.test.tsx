import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StandardChatMessageItem } from "../StandardChatSurface";
import type { ChatMessageInfo } from "../../hooks/chatTypes";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }) }));

/*
FNXC:ChatInterruptedVisibility 2026-09-17-16:16:
An interrupted turn's only surviving output is its partial text plus thinking, but the thinking
disclosure defaulted to collapsed and nothing on the row said the turn was stopped — an operator
reading an ai_workstation chat (msg-7b71d32b, model container restarted mid-turn) saw an
unexplained short bubble. Interrupted rows must announce themselves and open the thinking by
default; a whitespace-only turn that carries thinking/tool calls must say no reply was generated;
normal rows keep the collapsed default and no notices.
*/

const shared = {
  forcePlain: false,
  agentName: "Assistant",
  hideAssistantIdentity: false,
  showAssistantModelTag: false,
  activeModelTag: null,
  activeModelProvider: null,
  activeSessionId: "session-1",
};

function message(overrides: Partial<ChatMessageInfo> = {}): ChatMessageInfo {
  return {
    id: "message-1",
    role: "assistant",
    content: "Hello",
    createdAt: new Date("2026-09-17T15:39:03Z").toISOString(),
    ...overrides,
  } as ChatMessageInfo;
}

function renderItem(overrides: Partial<ChatMessageInfo>) {
  return render(<StandardChatMessageItem message={message(overrides)} {...shared} projectId="project-1" />);
}

describe("interrupted and no-reply assistant rows", () => {
  it("announces an interrupted turn and opens its thinking disclosure by default", () => {
    renderItem({
      content: "Schválené. Aplikujem",
      thinkingOutput: "Overím compose konfiguráciu…",
      metadata: { interrupted: true },
    });
    expect(screen.getByTestId("chat-message-interrupted")).toBeInTheDocument();
    const disclosure = document.querySelector("details.chat-message-thinking");
    expect(disclosure).not.toBeNull();
    expect((disclosure as HTMLDetailsElement).open).toBe(true);
    expect(screen.queryByTestId("chat-message-no-reply")).not.toBeInTheDocument();
  });

  it("says the model produced no reply when a whitespace-only turn carries thinking", () => {
    renderItem({
      content: "\n\n\n",
      thinkingOutput: "Planujem dalsie kroky…",
    });
    expect(screen.getByTestId("chat-message-no-reply")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-message-interrupted")).not.toBeInTheDocument();
    const disclosure = document.querySelector("details.chat-message-thinking");
    expect((disclosure as HTMLDetailsElement).open).toBe(false);
  });

  it("leaves a normal completed reply untouched: no notice, thinking collapsed", () => {
    renderItem({ content: "Hotovo.", thinkingOutput: "Krátke zamyslenie" });
    expect(screen.queryByTestId("chat-message-interrupted")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-message-no-reply")).not.toBeInTheDocument();
    const disclosure = document.querySelector("details.chat-message-thinking");
    expect((disclosure as HTMLDetailsElement).open).toBe(false);
  });
});

/*
FNXC:ChatTurnRetry 2026-09-17-16:30:
The honest notices carry a Retry action only when the caller can resend the prompt; surfaces
without a resend path must not render a dead button (empty-shell rule).
*/
describe("Retry action on reply-less and interrupted turns", () => {
  it("renders Retry on both notices and hands the assistant message to the caller", () => {
    const onRetryTurn = vi.fn();
    const { unmount } = render(
      <StandardChatMessageItem
        message={message({ content: "", thinkingOutput: "cosi", metadata: { interrupted: true } })}
        {...shared}
        projectId="project-1"
        onRetryTurn={onRetryTurn}
      />,
    );
    fireEvent.click(screen.getByTestId("chat-retry-turn-message-1"));
    expect(onRetryTurn).toHaveBeenCalledWith(expect.objectContaining({ id: "message-1" }));
    unmount();

    render(
      <StandardChatMessageItem
        message={message({ content: "\n\n", thinkingOutput: "cosi" })}
        {...shared}
        projectId="project-1"
        onRetryTurn={onRetryTurn}
      />,
    );
    fireEvent.click(screen.getByTestId("chat-retry-turn-message-1"));
    expect(onRetryTurn).toHaveBeenCalledTimes(2);
  });

  it("omits Retry when the surface has no resend path", () => {
    renderItem({ content: "", thinkingOutput: "cosi", metadata: { interrupted: true } });
    expect(screen.queryByTestId("chat-retry-turn-message-1")).not.toBeInTheDocument();
  });
});
