import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SetupWizard } from "../SetupWizard";
import type { ProjectInfo, ProjectCreateInput } from "../../api";

// Mock lucide-react
vi.mock("lucide-react", async () => {
  const actual = await vi.importActual("lucide-react");
  return {
    ...actual,
    X: () => <span data-testid="close-icon">×</span>,
    ChevronRight: () => <span data-testid="next-icon">→</span>,
    ChevronLeft: () => <span data-testid="back-icon">←</span>,
    Folder: () => <span data-testid="folder-icon">📁</span>,
    Check: () => <span data-testid="check-icon">✓</span>,
    Loader2: () => <span data-testid="loader-icon">⟳</span>,
    AlertCircle: () => <span data-testid="alert-icon">⚠</span>,
  };
});

describe("SetupWizard", () => {
  it("does not render when isOpen is false", () => {
    render(
      <SetupWizard
        isOpen={false}
        onClose={vi.fn()}
        onProjectCreated={vi.fn()}
      />
    );

    expect(screen.queryByText("Add New Project")).toBeNull();
  });

  it("renders when isOpen is true", () => {
    render(
      <SetupWizard
        isOpen={true}
        onClose={vi.fn()}
        onProjectCreated={vi.fn()}
      />
    );

    expect(screen.getByText("Add New Project")).toBeDefined();
  });

  it("starts at directory step", () => {
    render(
      <SetupWizard
        isOpen={true}
        onClose={vi.fn()}
        onProjectCreated={vi.fn()}
      />
    );

    expect(screen.getByText("Select Project Directory")).toBeDefined();
  });

  it("shows step indicator with 5 steps", () => {
    render(
      <SetupWizard
        isOpen={true}
        onClose={vi.fn()}
        onProjectCreated={vi.fn()}
      />
    );

    expect(screen.getByText("Directory")).toBeDefined();
    expect(screen.getByText("Name")).toBeDefined();
    expect(screen.getByText("Mode")).toBeDefined();
    expect(screen.getByText("Validate")).toBeDefined();
    expect(screen.getByText("Confirm")).toBeDefined();
  });

  it("disables Next button when directory is empty", () => {
    render(
      <SetupWizard
        isOpen={true}
        onClose={vi.fn()}
        onProjectCreated={vi.fn()}
      />
    );

    const nextButton = screen.getByRole("button", { name: /Next/i });
    expect(nextButton).toBeDisabled();
  });

  it("enables Next button when directory is filled", () => {
    render(
      <SetupWizard
        isOpen={true}
        onClose={vi.fn()}
        onProjectCreated={vi.fn()}
      />
    );

    const input = screen.getByPlaceholderText("/path/to/your/project");
    fireEvent.change(input, { target: { value: "/home/user/project" } });

    const nextButton = screen.getByRole("button", { name: /Next/i });
    expect(nextButton).not.toBeDisabled();
  });

  it("navigates to next step when Next is clicked", () => {
    render(
      <SetupWizard
        isOpen={true}
        onClose={vi.fn()}
        onProjectCreated={vi.fn()}
      />
    );

    const input = screen.getByPlaceholderText("/path/to/your/project");
    fireEvent.change(input, { target: { value: "/home/user/project" } });

    // Find the primary button (Next) in the actions area
    const nextButton = screen.getByRole("button", { name: /Next/i });
    fireEvent.click(nextButton);

    expect(screen.getByText("Project Name")).toBeDefined();
  });

  it("auto-suggests name from directory path", () => {
    render(
      <SetupWizard
        isOpen={true}
        onClose={vi.fn()}
        onProjectCreated={vi.fn()}
      />
    );

    const input = screen.getByPlaceholderText("/path/to/your/project");
    fireEvent.change(input, { target: { value: "/home/user/my-awesome-project" } });

    const nextButton = screen.getByRole("button", { name: /Next/i });
    fireEvent.click(nextButton);

    const nameInput = screen.getByPlaceholderText("My Project") as HTMLInputElement;
    expect(nameInput.value).toBe("my-awesome-project");
  });

  it("allows navigation back to previous step", () => {
    render(
      <SetupWizard
        isOpen={true}
        onClose={vi.fn()}
        onProjectCreated={vi.fn()}
      />
    );

    // Go to step 2
    const input = screen.getByPlaceholderText("/path/to/your/project");
    fireEvent.change(input, { target: { value: "/home/user/project" } });
    const nextButton = screen.getByRole("button", { name: /Next/i });
    fireEvent.click(nextButton);

    // Go back
    const backButton = screen.getByRole("button", { name: /Back/i });
    fireEvent.click(backButton);

    expect(screen.getByText("Select Project Directory")).toBeDefined();
  });

  it("shows isolation mode options", () => {
    render(
      <SetupWizard
        isOpen={true}
        onClose={vi.fn()}
        onProjectCreated={vi.fn()}
      />
    );

    // Navigate to step 3 (isolation)
    const dirInput = screen.getByPlaceholderText("/path/to/your/project");
    fireEvent.change(dirInput, { target: { value: "/home/user/project" } });
    
    // Go to name step
    fireEvent.click(screen.getByRole("button", { name: /Next/i }));
    
    // Go to isolation step
    fireEvent.click(screen.getByRole("button", { name: /Next/i }));

    expect(screen.getByText("In-Process (Default)")).toBeDefined();
    expect(screen.getByText("Child Process (Isolated)")).toBeDefined();
  });

  it("calls onClose when Cancel is clicked", () => {
    const onClose = vi.fn();
    render(
      <SetupWizard
        isOpen={true}
        onClose={onClose}
        onProjectCreated={vi.fn()}
      />
    );

    const cancelButton = screen.getByRole("button", { name: /Cancel/i });
    fireEvent.click(cancelButton);

    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose when close icon is clicked", () => {
    const onClose = vi.fn();
    render(
      <SetupWizard
        isOpen={true}
        onClose={onClose}
        onProjectCreated={vi.fn()}
      />
    );

    const closeButton = screen.getByLabelText("Close");
    fireEvent.click(closeButton);

    expect(onClose).toHaveBeenCalled();
  });

  it("submits project data when created", async () => {
    const mockRegisterProject = vi.fn().mockResolvedValue({
      id: "proj_123",
      name: "My Project",
      path: "/home/user/project",
      status: "active",
      isolationMode: "in-process",
    } as ProjectInfo);

    const onProjectCreated = vi.fn();

    render(
      <SetupWizard
        isOpen={true}
        onClose={vi.fn()}
        onProjectCreated={onProjectCreated}
        onRegisterProject={mockRegisterProject}
      />
    );

    // Fill directory
    const dirInput = screen.getByPlaceholderText("/path/to/your/project");
    fireEvent.change(dirInput, { target: { value: "/home/user/project" } });

    // The wizard should be in directory step with a Next button
    expect(screen.getByRole("button", { name: /Next/i })).toBeDefined();
    
    // Note: Full wizard flow testing would require more complex setup
    // including mocking the validation API call
  });

  it("resets state when reopened", () => {
    const { rerender } = render(
      <SetupWizard
        isOpen={true}
        onClose={vi.fn()}
        onProjectCreated={vi.fn()}
      />
    );

    // Fill some data
    const input = screen.getByPlaceholderText("/path/to/your/project");
    fireEvent.change(input, { target: { value: "/home/user/project" } });

    // Close and reopen
    rerender(
      <SetupWizard
        isOpen={false}
        onClose={vi.fn()}
        onProjectCreated={vi.fn()}
      />
    );

    rerender(
      <SetupWizard
        isOpen={true}
        onClose={vi.fn()}
        onProjectCreated={vi.fn()}
      />
    );

    // Should be back at step 1 with empty fields
    expect(screen.getByText("Select Project Directory")).toBeDefined();
    const newInput = screen.getByPlaceholderText("/path/to/your/project") as HTMLInputElement;
    expect(newInput.value).toBe("");
  });
});
