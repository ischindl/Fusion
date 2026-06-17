import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { readFileSync } from "fs";
import { resolve } from "path";
import { Bar } from "../charts/Bar";
import { StackedBar } from "../charts/StackedBar";
import { Sparkline } from "../charts/Sparkline";
import { Funnel } from "../charts/Funnel";

function widthOf(el: HTMLElement): string {
  return el.style.width;
}

function heightOf(el: HTMLElement): string {
  return el.style.height;
}

describe("Bar", () => {
  it("renders a fill per datum and an accessible label", () => {
    render(
      <Bar
        ariaLabel="tokens by model"
        data={[
          { label: "gpt-4", value: 100 },
          { label: "sonnet", value: 50 },
        ]}
      />,
    );
    expect(screen.getByRole("list", { name: "tokens by model" })).toBeTruthy();
    expect(screen.getByLabelText("gpt-4: 100")).toBeTruthy();
    expect(screen.getByLabelText("sonnet: 50")).toBeTruthy();
  });

  it("renders the largest value at 100% and scales the rest", () => {
    render(<Bar data={[{ label: "a", value: 100 }, { label: "b", value: 25 }]} />);
    expect(widthOf(screen.getByLabelText("a: 100"))).toBe("100%");
    expect(widthOf(screen.getByLabelText("b: 25"))).toBe("25%");
  });

  it("renders a 0-width bar for a zero value, never NaN", () => {
    render(<Bar data={[{ label: "zero", value: 0 }, { label: "x", value: 10 }]} />);
    const zero = screen.getByLabelText("zero: 0");
    expect(widthOf(zero)).toBe("0%");
    expect(widthOf(zero)).not.toContain("NaN");
  });

  it("renders 0-width bars for an all-zero dataset without dividing by zero", () => {
    render(<Bar data={[{ label: "a", value: 0 }, { label: "b", value: 0 }]} />);
    expect(widthOf(screen.getByLabelText("a: 0"))).toBe("0%");
    expect(widthOf(screen.getByLabelText("b: 0"))).toBe("0%");
  });

  it("treats a non-finite value as zero width", () => {
    render(<Bar data={[{ label: "nan", value: Number.NaN }]} />);
    const el = screen.getByLabelText("nan: 0");
    expect(widthOf(el)).toBe("0%");
  });
});

describe("StackedBar", () => {
  it("renders proportional segments and a legend", () => {
    render(
      <StackedBar
        ariaLabel="status split"
        segments={[
          { label: "done", value: 75 },
          { label: "open", value: 25 },
        ]}
      />,
    );
    expect(screen.getByRole("img", { name: "status split" })).toBeTruthy();
    expect(widthOf(screen.getByLabelText("done: 75"))).toBe("75%");
    expect(widthOf(screen.getByLabelText("open: 25"))).toBe("25%");
  });

  it("renders 0-width slices for an all-zero set, never NaN", () => {
    render(<StackedBar segments={[{ label: "a", value: 0 }, { label: "b", value: 0 }]} />);
    expect(widthOf(screen.getByLabelText("a: 0"))).toBe("0%");
    expect(widthOf(screen.getByLabelText("b: 0"))).toBe("0%");
  });
});

describe("Sparkline", () => {
  it("renders one bar per value with proportional heights", () => {
    render(<Sparkline ariaLabel="models per day" values={[2, 4, 0]} />);
    const sparkline = screen.getByRole("img", { name: "models per day" });
    const bars = sparkline.querySelectorAll<HTMLElement>(".cc-sparkline-bar");
    expect(bars.length).toBe(3);
    expect(heightOf(bars[0])).toBe("50%");
    expect(heightOf(bars[1])).toBe("100%");
    expect(heightOf(bars[2])).toBe("0%");
  });

  it("renders 0-height bars for all-zero values without NaN", () => {
    render(<Sparkline ariaLabel="empty" values={[0, 0]} />);
    const bars = screen.getByRole("img", { name: "empty" }).querySelectorAll<HTMLElement>(".cc-sparkline-bar");
    expect(heightOf(bars[0])).toBe("0%");
    expect(heightOf(bars[1])).toBe("0%");
  });
});

describe("Funnel", () => {
  it("renders stages with conversion from the prior stage", () => {
    render(
      <Funnel
        ariaLabel="sdlc"
        stages={[
          { label: "triage", value: 100 },
          { label: "todo", value: 50 },
          { label: "done", value: 25 },
        ]}
      />,
    );
    expect(widthOf(screen.getByLabelText("triage: 100"))).toBe("100%");
    expect(widthOf(screen.getByLabelText("todo: 50"))).toBe("50%");
    // first stage has no conversion label; subsequent stages do (todo=50%, done=50%)
    expect(screen.getAllByText("50%").length).toBe(2);
  });

  it("shows a — conversion when the prior stage is zero, never NaN%", () => {
    render(<Funnel stages={[{ label: "a", value: 0 }, { label: "b", value: 5 }]} />);
    expect(screen.getByText("—")).toBeTruthy();
    expect(widthOf(screen.getByLabelText("a: 0"))).toBe("0%");
  });
});

/**
 * Real-browser-style guard for the IACVT token trap: the chart CSS must drive
 * its loader animation off a bare --duration-* token, never a --transition-*
 * duration+easing pair (which silently resolves to animation: none).
 */
describe("chart CSS animation tokens", () => {
  const cssPath = resolve(__dirname, "../charts/charts.css");
  const css = readFileSync(cssPath, "utf8");

  it("uses a --duration-* token in the loader animation, not --transition-*", () => {
    const animationLines = css.split("\n").filter((line) => /animation\s*:/.test(line));
    expect(animationLines.length).toBeGreaterThan(0);
    for (const line of animationLines) {
      expect(line).not.toMatch(/var\(--transition-/);
      expect(line).toMatch(/var\(--duration-/);
    }
  });
});
