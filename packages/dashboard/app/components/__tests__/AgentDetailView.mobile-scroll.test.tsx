import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { loadAllAppCss, loadAllAppCssBaseOnly } from "../../test/cssFixture";
import { setupAgentDetailMocks } from "./AgentDetailView.test-helpers";
import { AgentDetailView } from "../AgentDetailView";

function installAgentDetailMatchMedia(matchesMobile: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: matchesMobile && query.includes("max-width: 768px"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe("AgentDetailView mobile scroll regression (FN-4231)", () => {
  beforeEach(() => {
    setupAgentDetailMocks();
    document.head.querySelector("style[data-testid='fn-4231-css']")?.remove();
    const style = document.createElement("style");
    style.setAttribute("data-testid", "fn-4231-css");
    style.textContent = loadAllAppCss();
    document.head.appendChild(style);

    installAgentDetailMatchMedia(true);
  });

  it("keeps AgentDetailView tab body as the mobile scroll owner (FN-4231)", async () => {
    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(document.querySelector(".agent-detail-content")).toBeTruthy();
    });

    const contentEl = document.querySelector(".agent-detail-content") as HTMLElement;
    const tabsEl = document.querySelector(".agent-detail-tabs") as HTMLElement;
    const footerEl = document.querySelector(".agent-detail-footer") as HTMLElement;

    expect(window.getComputedStyle(contentEl).minHeight).toBe("0px");
    expect(window.getComputedStyle(contentEl).overflowY).toBe("auto");
    expect(window.getComputedStyle(tabsEl).flexShrink).toBe("0");
    expect(window.getComputedStyle(footerEl).flexShrink).toBe("0");
  });

  it("tabs accept horizontal touch panning and stay non-shrinking on mobile (FN-6450, FN-6865)", async () => {
    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(document.querySelector(".agent-detail-tabs")).toBeTruthy();
    });

    const tabsEl = document.querySelector(".agent-detail-tabs") as HTMLElement;
    const tabEl = document.querySelector(".agent-detail-tab") as HTMLElement;
    const tabsStyle = window.getComputedStyle(tabsEl);
    const tabStyle = window.getComputedStyle(tabEl);

    expect(tabsStyle.touchAction).toBe("pan-x pan-y");
    expect(tabsStyle.touchAction).toContain("pan-x");
    expect(tabsStyle.overflowX).toBe("auto");
    expect(tabStyle.touchAction).toContain("pan-x");
    expect(tabStyle.flexShrink).toBe("0");
  });

  it("tabs are horizontally scrollable at tablet widths (FN-6209)", async () => {
    installAgentDetailMatchMedia(false);

    const style = document.head.querySelector("style[data-testid='fn-4231-css']") as HTMLStyleElement;
    style.textContent = loadAllAppCssBaseOnly();

    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(document.querySelector(".agent-detail-tabs")).toBeTruthy();
    });

    const tabsEl = document.querySelector(".agent-detail-tabs") as HTMLElement;
    const tabEl = document.querySelector(".agent-detail-tab") as HTMLElement;

    const tabStyle = window.getComputedStyle(tabEl);

    expect(window.getComputedStyle(tabsEl).overflowX).toBe("auto");
    expect(tabStyle.touchAction).toContain("pan-x");
    expect(tabStyle.whiteSpace).toBe("nowrap");
    expect(tabStyle.flexShrink).toBe("0");
  });

  it("keeps tab labels readable across tablet and mobile states (FN-6728)", async () => {
    const style = document.head.querySelector("style[data-testid='fn-4231-css']") as HTMLStyleElement;

    installAgentDetailMatchMedia(false);
    style.textContent = loadAllAppCssBaseOnly();

    const desktopRender = render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(document.querySelector(".agent-detail-tab")).toBeTruthy();
    });

    const baseTabEl = document.querySelector(".agent-detail-tab") as HTMLElement;
    expect(window.getComputedStyle(baseTabEl).fontSize).toBe("0.875rem");

    desktopRender.unmount();
    cleanup();

    document.head.querySelector("style[data-testid='fn-4231-css']")?.remove();
    const mobileStyle = document.createElement("style");
    mobileStyle.setAttribute("data-testid", "fn-4231-css");
    mobileStyle.textContent = loadAllAppCss();
    document.head.appendChild(mobileStyle);
    installAgentDetailMatchMedia(true);

    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(document.querySelector(".agent-detail-tab")).toBeTruthy();
    });

    const mobileTabEl = document.querySelector(".agent-detail-tab") as HTMLElement;
    expect(window.getComputedStyle(mobileTabEl).fontSize).toBe("0.875rem");
  });
});
