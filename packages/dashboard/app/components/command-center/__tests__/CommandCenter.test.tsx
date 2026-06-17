import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { CommandCenter } from "../CommandCenter";

describe("CommandCenter shell", () => {
  it("renders with the Overview tab active by default", () => {
    render(<CommandCenter />);
    const overviewTab = screen.getByTestId("command-center-tab-overview");
    expect(overviewTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("command-center-panel-overview")).toBeTruthy();
  });

  it("renders the documented empty state when there is no data (no crash)", () => {
    render(<CommandCenter />);
    expect(screen.getByTestId("command-center-empty")).toBeTruthy();
  });

  it("exposes the ARIA tabs pattern (tablist + tabs + tabpanel)", () => {
    render(<CommandCenter />);
    const tablist = screen.getByRole("tablist");
    const tabs = within(tablist).getAllByRole("tab");
    // Overview, Tokens, Tools, Activity, Productivity, Ecosystem, Signals, Mission Control.
    expect(tabs.length).toBe(8);
    // roving tabindex: exactly one tab is focusable.
    const focusable = tabs.filter((tab) => tab.getAttribute("tabindex") === "0");
    expect(focusable.length).toBe(1);
    expect(screen.getByRole("tabpanel")).toBeTruthy();
  });

  it("activates a tab on click and updates aria-selected", () => {
    render(<CommandCenter />);
    fireEvent.click(screen.getByTestId("command-center-tab-tokens"));
    expect(screen.getByTestId("command-center-tab-tokens").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("command-center-tab-overview").getAttribute("aria-selected")).toBe("false");
    expect(screen.getByTestId("command-center-panel-tokens")).toBeTruthy();
  });

  it("supports arrow-key navigation between tabs (roving tabindex)", () => {
    render(<CommandCenter />);
    const overviewTab = screen.getByTestId("command-center-tab-overview");
    overviewTab.focus();
    fireEvent.keyDown(overviewTab, { key: "ArrowRight" });
    const tokensTab = screen.getByTestId("command-center-tab-tokens");
    expect(tokensTab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tokensTab);
  });

  it("wraps with ArrowLeft from the first tab to the last", () => {
    render(<CommandCenter />);
    const overviewTab = screen.getByTestId("command-center-tab-overview");
    overviewTab.focus();
    fireEvent.keyDown(overviewTab, { key: "ArrowLeft" });
    const last = screen.getByTestId("command-center-tab-mission-control");
    expect(last.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(last);
  });

  it("activates with Enter and Space", () => {
    render(<CommandCenter />);
    const toolsTab = screen.getByTestId("command-center-tab-tools");
    fireEvent.keyDown(toolsTab, { key: "Enter" });
    expect(toolsTab.getAttribute("aria-selected")).toBe("true");

    const activityTab = screen.getByTestId("command-center-tab-activity");
    fireEvent.keyDown(activityTab, { key: " " });
    expect(activityTab.getAttribute("aria-selected")).toBe("true");
  });

  it("makes the active tabpanel focusable (Tab moves into the panel)", () => {
    render(<CommandCenter />);
    const panel = screen.getByTestId("command-center-panel-overview");
    expect(panel.getAttribute("tabindex")).toBe("0");
    expect(panel.getAttribute("role")).toBe("tabpanel");
  });

  it("renders a date-range picker that returns focus to its trigger on dismiss", () => {
    render(<CommandCenter />);
    const trigger = screen.getByTestId("cc-date-range-trigger");
    fireEvent.click(trigger);
    expect(screen.getByTestId("cc-date-range-popover")).toBeTruthy();
    // Escape dismisses and returns focus to the trigger.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("cc-date-range-popover")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
