import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { THINKING_LEVELS } from "@fusion/core";
import { ChatThinkingLevelControl } from "../ChatThinkingLevelControl";

describe("ChatThinkingLevelControl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the Brain trigger and no popup by default", () => {
    render(<ChatThinkingLevelControl level={null} onChange={vi.fn()} />);

    const trigger = screen.getByTestId("chat-thinking-btn");
    expect(trigger).toBeDefined();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("opens a popup listing Default plus all six THINKING_LEVELS when the trigger is clicked", () => {
    render(<ChatThinkingLevelControl level={null} onChange={vi.fn()} />);

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));

    const listbox = screen.getByRole("listbox");
    expect(listbox).toBeDefined();
    expect(screen.getByTestId("chat-thinking-option-default")).toBeDefined();
    for (const level of THINKING_LEVELS) {
      expect(screen.getByTestId(`chat-thinking-option-${level}`)).toBeDefined();
    }
    expect(screen.getAllByRole("option")).toHaveLength(THINKING_LEVELS.length + 1);
  });

  it("selecting a level calls onChange with that level and closes the popup", () => {
    const onChange = vi.fn();
    render(<ChatThinkingLevelControl level={null} onChange={onChange} />);

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    fireEvent.click(screen.getByTestId("chat-thinking-option-high"));

    expect(onChange).toHaveBeenCalledWith("high");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("selecting Default calls onChange with an empty string", () => {
    const onChange = vi.fn();
    render(<ChatThinkingLevelControl level="high" onChange={onChange} />);

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    fireEvent.click(screen.getByTestId("chat-thinking-option-default"));

    expect(onChange).toHaveBeenCalledWith("");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("clicking outside closes the popup without calling onChange", () => {
    const onChange = vi.fn();
    render(<ChatThinkingLevelControl level={null} onChange={onChange} />);

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    expect(screen.getByRole("listbox")).toBeDefined();

    fireEvent.pointerDown(document.body);

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Escape closes the popup", () => {
    render(<ChatThinkingLevelControl level={null} onChange={vi.fn()} />);

    const trigger = screen.getByTestId("chat-thinking-btn");
    fireEvent.click(trigger);
    expect(screen.getByRole("listbox")).toBeDefined();

    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("shows the active-state class only when level is a concrete value", () => {
    const { rerender } = render(<ChatThinkingLevelControl level={null} onChange={vi.fn()} />);
    expect(screen.getByTestId("chat-thinking-btn").className).not.toContain("chat-thinking-btn--active");

    rerender(<ChatThinkingLevelControl level={undefined} onChange={vi.fn()} />);
    expect(screen.getByTestId("chat-thinking-btn").className).not.toContain("chat-thinking-btn--active");

    rerender(<ChatThinkingLevelControl level="" onChange={vi.fn()} />);
    expect(screen.getByTestId("chat-thinking-btn").className).not.toContain("chat-thinking-btn--active");

    rerender(<ChatThinkingLevelControl level="medium" onChange={vi.fn()} />);
    expect(screen.getByTestId("chat-thinking-btn").className).toContain("chat-thinking-btn--active");
  });

  it("disabled prevents opening", () => {
    render(<ChatThinkingLevelControl level={null} onChange={vi.fn()} disabled />);

    const trigger = screen.getByTestId("chat-thinking-btn");
    expect(trigger).toBeDisabled();

    fireEvent.click(trigger);
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
