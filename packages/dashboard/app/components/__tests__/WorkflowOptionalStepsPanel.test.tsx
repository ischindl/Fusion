import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { useState } from "react";
import type { WorkflowOptionalStep } from "@fusion/core";
import { WorkflowOptionalStepsPanel } from "../WorkflowOptionalStepsPanel";

// Controlled host mirroring how WorkflowNodeEditor drives the panel.
function Host({
  initial,
  readOnly = false,
  onState,
}: {
  initial: WorkflowOptionalStep[];
  readOnly?: boolean;
  onState?: (s: WorkflowOptionalStep[]) => void;
}) {
  const [optionalSteps, setOptionalSteps] = useState<WorkflowOptionalStep[]>(initial);
  return (
    <WorkflowOptionalStepsPanel
      optionalSteps={optionalSteps}
      readOnly={readOnly}
      onChange={(next) => {
        setOptionalSteps(next);
        onState?.(next);
      }}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WorkflowOptionalStepsPanel", () => {
  it("renders the empty state and an add picker when no steps are declared", () => {
    render(<Host initial={[]} />);
    expect(screen.getByText(/No optional steps/i)).toBeTruthy();
    const select = screen.getByTestId("wf-optional-steps-add-select") as HTMLSelectElement;
    // browser-verification is in the catalog and not yet declared → available.
    expect(within(select).getByRole("option", { name: "Browser Verification" })).toBeTruthy();
  });

  it("adds a step from the picker (defaultOn false) and removes it from the picker", () => {
    const onState = vi.fn();
    render(<Host initial={[]} onState={onState} />);
    fireEvent.change(screen.getByTestId("wf-optional-steps-add-select"), {
      target: { value: "browser-verification" },
    });
    expect(onState).toHaveBeenCalledWith([{ templateId: "browser-verification", defaultOn: false }]);
    // The declared row is shown with the resolved template name…
    const row = screen.getByTestId("wf-optional-step-browser-verification");
    expect(within(row).getByText("Browser Verification")).toBeTruthy();
    // …and the picker no longer offers it.
    const select = screen.getByTestId("wf-optional-steps-add-select") as HTMLSelectElement;
    expect(within(select).queryByRole("option", { name: "Browser Verification" })).toBeNull();
  });

  it("toggles defaultOn for a declared step", () => {
    const onState = vi.fn();
    render(<Host initial={[{ templateId: "browser-verification", defaultOn: false }]} onState={onState} />);
    const row = screen.getByTestId("wf-optional-step-browser-verification");
    fireEvent.click(within(row).getByRole("checkbox"));
    expect(onState).toHaveBeenCalledWith([{ templateId: "browser-verification", defaultOn: true }]);
  });

  it("removes a declared step and returns it to the picker", () => {
    render(<Host initial={[{ templateId: "browser-verification" }]} />);
    const row = screen.getByTestId("wf-optional-step-browser-verification");
    fireEvent.click(within(row).getByRole("button", { name: /Remove optional step/i }));
    expect(screen.queryByTestId("wf-optional-step-browser-verification")).toBeNull();
    const select = screen.getByTestId("wf-optional-steps-add-select") as HTMLSelectElement;
    expect(within(select).getByRole("option", { name: "Browser Verification" })).toBeTruthy();
  });

  it("renders an unknown/stale templateId as a muted, still-removable row", () => {
    const onState = vi.fn();
    render(<Host initial={[{ templateId: "does-not-exist" }]} onState={onState} />);
    const row = screen.getByTestId("wf-optional-step-does-not-exist");
    expect(row.className).toContain("is-unknown");
    expect(within(row).getByText(/Unknown step/i)).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: /Remove optional step/i }));
    expect(onState).toHaveBeenCalledWith([]);
  });

  it("disables editing when readOnly", () => {
    render(<Host initial={[{ templateId: "browser-verification" }]} readOnly />);
    const row = screen.getByTestId("wf-optional-step-browser-verification");
    expect((within(row).getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
    expect((within(row).getByRole("button", { name: /Remove optional step/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});
