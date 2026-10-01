import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ChatPresentationToggle } from "../ChatPresentationToggle";
import { readStoredChatLaunchMode, writeStoredChatLaunchMode } from "../../utils/chatLaunchMode";

/*
FNXC:ChatPresentationToggleTest 2026-09-16-21:57:
The segment control is the operator's switch between the anchored chat popover and the persistent
side surface. Both segments always render; the active mode carries aria-pressed; each click reports
the chosen mode so the App controller can persist it AND re-present the surface. The launch-mode
helper defaults to "popup" when storage is absent and round-trips "view", falling back to "popup"
when storage reads are unusable (private mode).
*/

describe("ChatPresentationToggle", () => {
  it("marks the active mode and reports clicks for both segments", async () => {
    const user = userEvent.setup();
    const onModeChange = vi.fn();
    render(<ChatPresentationToggle mode="popup" onModeChange={onModeChange} />);

    const popup = screen.getByTestId("chat-presentation-popup");
    const view = screen.getByTestId("chat-presentation-view");
    expect(popup).toHaveAttribute("aria-pressed", "true");
    expect(view).toHaveAttribute("aria-pressed", "false");

    await user.click(view);
    expect(onModeChange).toHaveBeenCalledWith("view");

    await user.click(popup);
    expect(onModeChange).toHaveBeenCalledWith("popup");
  });

  it("reflects the view mode as pressed", () => {
    render(<ChatPresentationToggle mode="view" onModeChange={vi.fn()} />);
    expect(screen.getByTestId("chat-presentation-view")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("chat-presentation-popup")).toHaveAttribute("aria-pressed", "false");
  });
});

describe("chatLaunchMode storage", () => {
  it("persists under the exact ASCII key (operator-visible, greppable)", () => {
    window.localStorage.clear();
    writeStoredChatLaunchMode("view");
    expect(window.localStorage.getItem("fusion:chat-launch-mode")).toBe("view");
    /* The historical defect: a U+2026 slipped into the key, so the mode lived outside every probe. */
    expect(window.localStorage.getItem("fusion:cha…-mode")).toBeNull();
    expect(window.localStorage.getItem("fusion:chat…mode")).toBeNull();
  });

  it("defaults to popup and round-trips view", () => {
    window.localStorage.clear();
    expect(readStoredChatLaunchMode()).toBe("popup");
    writeStoredChatLaunchMode("view");
    expect(readStoredChatLaunchMode()).toBe("view");
    writeStoredChatLaunchMode("popup");
    expect(readStoredChatLaunchMode()).toBe("popup");
  });

  it("falls back to popup when storage is unreadable", () => {
    const original = window.localStorage;
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    try {
      expect(readStoredChatLaunchMode()).toBe("popup");
      expect(() => writeStoredChatLaunchMode("view")).not.toThrow();
    } finally {
      if (descriptor) Object.defineProperty(window, "localStorage", descriptor);
      else Object.defineProperty(window, "localStorage", { configurable: true, value: original });
    }
  });
});
