import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { COLOR_THEMES } from "../themeOptions";
import { ThemeDropdown } from "../ThemeDropdown";

describe("ThemeDropdown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the current theme chip and opens all swatched theme options", () => {
    render(<ThemeDropdown colorTheme="ocean" onColorThemeChange={vi.fn()} />);

    const trigger = screen.getByRole("button", { name: /ocean/i });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(within(trigger).getByText("Ocean")).toBeDefined();
    expect(trigger.querySelector(".theme-swatch-ocean")).toBeTruthy();

    fireEvent.click(trigger);

    const listbox = screen.getByRole("listbox", { name: /color theme/i });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    for (const theme of COLOR_THEMES) {
      const option = within(listbox)
        .getAllByRole("option")
        .find((element) => element.textContent?.trim().startsWith(theme.label));
      expect(option?.querySelector(`.${theme.className}`)).toBeTruthy();
    }
  });

  it("selects themes and closes from click, escape, and outside click", () => {
    const onColorThemeChange = vi.fn();
    render(<ThemeDropdown colorTheme="default" onColorThemeChange={onColorThemeChange} />);

    fireEvent.click(screen.getByRole("button", { name: /default/i }));
    fireEvent.click(screen.getAllByRole("option").find((element) => element.textContent?.trim() === "Forest")!);
    expect(onColorThemeChange).toHaveBeenCalledWith("forest");
    expect(screen.queryByRole("listbox")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /default/i }));
    fireEvent.keyDown(screen.getByRole("option", { name: /default/i }), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /default/i }));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("is keyboard-operable with arrows and enter", () => {
    const onColorThemeChange = vi.fn();
    render(<ThemeDropdown colorTheme="default" onColorThemeChange={onColorThemeChange} />);

    const trigger = screen.getByRole("button", { name: /default/i });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("option", { name: /default/i }), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("option", { name: /ocean/i }), { key: "Enter" });

    expect(onColorThemeChange).toHaveBeenCalledWith("ocean");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("renders compact theme mode controls when mode props are supplied", () => {
    const onThemeModeChange = vi.fn();
    render(
      <ThemeDropdown
        colorTheme="default"
        themeMode="dark"
        onColorThemeChange={vi.fn()}
        onThemeModeChange={onThemeModeChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /light/i }));
    expect(onThemeModeChange).toHaveBeenCalledWith("light");
  });

  it.each([
    ["without mode controls", undefined, undefined],
    ["with mode controls", "dark" as const, vi.fn()],
  ])("elevates the open popover above Command Center sibling cards %s", (_label, themeMode, onThemeModeChange) => {
    render(
      <ThemeDropdown
        colorTheme="default"
        themeMode={themeMode}
        onColorThemeChange={vi.fn()}
        onThemeModeChange={onThemeModeChange}
      />,
    );

    const trigger = screen.getByRole("button", { name: /default/i });
    const root = trigger.closest(".theme-dropdown");
    expect(root).toBeTruthy();
    expect(root?.classList.contains("open")).toBe(false);
    expect(getComputedStyle(root!).zIndex).not.toBe("40");

    fireEvent.click(trigger);

    const popover = document.querySelector<HTMLElement>(".theme-dropdown-popover");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(root?.classList.contains("open")).toBe(true);
    expect(getComputedStyle(root!).position).toBe("relative");
    expect(getComputedStyle(root!).zIndex).toBe("40");
    expect(popover).toBeTruthy();
    expect(getComputedStyle(popover!).position).toBe("absolute");
    expect(getComputedStyle(popover!).zIndex).toBe("40");
  });

  it("preserves the mobile static in-flow popover branch without dropdown elevation", () => {
    const css = readFileSync("app/components/ThemeDropdown.css", "utf8");

    expect(css).toMatch(
      /@media \(max-width: 768px\) \{[\s\S]*?\.theme-dropdown\.open \{[\s\S]*?z-index: auto;[\s\S]*?\.theme-dropdown-popover \{[\s\S]*?position: static;[\s\S]*?z-index: auto;/,
    );
  });
});
