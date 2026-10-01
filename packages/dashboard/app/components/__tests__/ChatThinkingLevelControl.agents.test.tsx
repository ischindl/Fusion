import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ChatThinkingLevelControl } from "../ChatThinkingLevelControl";

/*
FNXC:ChatAgentTargetSwitchTest 2026-09-16-22:12:
The composer target popover must let the operator pick a durable agent, not only a model — with the
Chat default set to Agent/CEO the old surface still offered nothing but model changes. Targeting an
agent clears the model pair; choosing "Chat as model" returns to the model lane by OMITTING agentId,
because `useChat.setSessionModel` treats any defined agentId as an agent switch. Rooms (no
showTargetSection) never see the list.
*/

const agents = [
  { id: "agent-ceo", name: "CEO" },
  { id: "agent-mk", name: "Memory Keeper" },
];

function openBrainPopover(props: Partial<Parameters<typeof ChatThinkingLevelControl>[0]> = {}) {
  const onChangeModel = props.onChangeModel ?? vi.fn();
  render(
    <ChatThinkingLevelControl
      level={null}
      onChange={vi.fn()}
      models={[]}
      agents={agents}
      {...props}
      onChangeModel={onChangeModel}
    />,
  );
  fireEvent.click(screen.getByTestId("chat-thinking-btn"));
  return { onChangeModel };
}

describe("ChatThinkingLevelControl agent targeting", () => {
  it("lists durable agents plus a model-lane option and emits the agent switch contract", () => {
    const { onChangeModel } = openBrainPopover();
    const list = screen.getByTestId("chat-thinking-agent-list");
    expect(list).toBeInTheDocument();
    expect(screen.getByTestId("chat-thinking-agent-agent-ceo")).toHaveTextContent("CEO");
    expect(screen.getByTestId("chat-thinking-agent-agent-mk")).toHaveTextContent("Memory Keeper");

    fireEvent.click(screen.getByTestId("chat-thinking-agent-agent-ceo"));
    expect(onChangeModel).toHaveBeenCalledWith({ agentId: "agent-ceo", modelProvider: null, modelId: null });
  });

  it("returns to the model lane by omitting agentId (a defined agentId is an agent switch)", () => {
    const { onChangeModel } = openBrainPopover({ agentId: "agent-ceo" });
    expect(screen.getByTestId("chat-thinking-agent-agent-ceo")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("chat-thinking-agent-model")).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(screen.getByTestId("chat-thinking-agent-model"));
    const emitted = onChangeModel.mock.lastCall?.[0] as Record<string, unknown>;
    expect(emitted).not.toHaveProperty("agentId");
    expect(emitted.modelProvider).toBeNull();
    expect(emitted.modelId).toBeNull();
  });

  it("hides the agent section for room hosts and without onChangeModel", () => {
    render(
      <ChatThinkingLevelControl
        level={null}
        onChange={vi.fn()}
        models={[]}
        agents={agents}
        showTargetSection={false}
        onChangeModel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    expect(screen.queryByTestId("chat-thinking-agent-list")).not.toBeInTheDocument();
  });
});
