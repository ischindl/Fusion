import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProjectNodeSelector } from "../ProjectNodeSelector";
import type { NodeInfo } from "../../api";

const nodes: NodeInfo[] = [
  { id: "node-1", name: "Alpha", type: "remote", status: "online", maxConcurrent: 2, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
  { id: "node-2", name: "Beta", type: "remote", status: "offline", maxConcurrent: 2, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
  { id: "node-3", name: "Gamma", type: "local", status: "error", maxConcurrent: 2, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
];

describe("ProjectNodeSelector", () => {
  it("renders select with auto option", () => {
    render(<ProjectNodeSelector projectId="p1" nodes={nodes} onSelect={vi.fn()} />);
    expect(screen.getByRole("option", { name: "Auto (no assignment)" })).toBeInTheDocument();
  });

  it("renders node option labels with type and status", () => {
    render(<ProjectNodeSelector projectId="p1" nodes={nodes} onSelect={vi.fn()} />);
    expect(screen.getByRole("option", { name: "Alpha (remote) — online" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Beta (remote) — offline" })).toBeInTheDocument();
  });

  it("dims offline and error options", () => {
    render(<ProjectNodeSelector projectId="p1" nodes={nodes} onSelect={vi.fn()} />);
    expect(screen.getByRole("option", { name: "Beta (remote) — offline" })).toHaveClass("project-node-selector__option--dim");
    expect(screen.getByRole("option", { name: "Gamma (local) — error" })).toHaveClass("project-node-selector__option--dim");
  });

  it("does not dim online options", () => {
    render(<ProjectNodeSelector projectId="p1" nodes={nodes} onSelect={vi.fn()} />);
    expect(screen.getByRole("option", { name: "Alpha (remote) — online" })).not.toHaveClass("project-node-selector__option--dim");
  });
});
