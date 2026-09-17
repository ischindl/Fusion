import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StandardChatMessageItem } from "../StandardChatSurface";
import type { ChatMessageInfo, ToolCallInfo } from "../../hooks/chatTypes";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }) }));

/*
FNXC:ChatFeedCompaction 2026-09-17-15:38:
The session feed delivers compacted tool calls (preview only, no bodies). Expanding a row must
lazy-load the full args/result exactly once, must not render a dead disclosure when no loader is
wired, and must degrade to a plain status line when the fetch fails — never an empty shell.
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

function compactedCall(overrides: Partial<ToolCallInfo> = {}): ToolCallInfo {
  return {
    toolName: "write_file",
    isError: false,
    status: "completed",
    compacted: true,
    previewKind: "result",
    previewText: "ok wrote 1200 lines…",
    hasFullDetails: true,
    ...overrides,
  };
}

function message(toolCalls: ToolCallInfo[]): ChatMessageInfo {
  return {
    id: "message-1",
    sessionId: "session-1",
    role: "assistant",
    content: "Reply",
    createdAt: "2026-09-17T00:00:00.000Z",
    toolCalls,
  };
}

describe("StandardChatMessageItem compacted tool calls", () => {
  it("shows the preview without bodies and lazy-loads the full details on first expand", async () => {
    const loadToolCallFull = vi.fn(async () => ({ args: { path: "/app/big.ts" }, result: "full-file-content-body" }));
    render(<StandardChatMessageItem {...shared} message={message([compactedCall()])} loadToolCallFull={loadToolCallFull} />);

    expect(screen.getByText("write_file")).toBeTruthy();
    expect(screen.getByText(/ok wrote 1200 lines…/)).toBeTruthy();
    expect(screen.queryByText("full-file-content-body")).toBeNull();

    fireEvent.click(screen.getByTestId("chat-tool-call-lazy-summary-message-1-0"));
    await waitFor(() => expect(screen.getByText(/full-file-content-body/)).toBeTruthy());
    expect(loadToolCallFull).toHaveBeenCalledTimes(1);
    expect(loadToolCallFull).toHaveBeenCalledWith("message-1", 0);
    expect(screen.getByText(/path/)).toBeTruthy();

    // Collapsing and re-expanding must not refetch.
    fireEvent.click(screen.getByTestId("chat-tool-call-lazy-summary-message-1-0"));
    fireEvent.click(screen.getByTestId("chat-tool-call-lazy-summary-message-1-0"));
    expect(loadToolCallFull).toHaveBeenCalledTimes(1);
  });

  it("shows a failure line when the full body cannot be loaded", async () => {
    const loadToolCallFull = vi.fn(async () => null);
    render(<StandardChatMessageItem {...shared} message={message([compactedCall()])} loadToolCallFull={loadToolCallFull} />);
    fireEvent.click(screen.getByTestId("chat-tool-call-lazy-summary-message-1-0"));
    await waitFor(() => expect(screen.getByText(/Could not load the full details/)).toBeTruthy());
  });

  it("renders no disclosure affordance without a loader", () => {
    const { queryByTestId, getByText } = render(<StandardChatMessageItem {...shared} message={message([compactedCall()])} />);
    expect(queryByTestId("chat-tool-call-lazy-summary-message-1-0")).toBeNull();
    expect(getByText(/ok wrote 1200 lines…/)).toBeTruthy();
  });

  it("renders no disclosure affordance when the server holds no bodies", () => {
    const { queryByTestId, getByText } = render(
      <StandardChatMessageItem
        {...shared}
        message={message([compactedCall({ previewText: undefined, previewKind: undefined, hasFullDetails: false })])}
        loadToolCallFull={vi.fn(async () => null)}
      />,
    );
    expect(queryByTestId("chat-tool-call-lazy-summary-message-1-0")).toBeNull();
    expect(getByText("write_file")).toBeTruthy();
  });
});
