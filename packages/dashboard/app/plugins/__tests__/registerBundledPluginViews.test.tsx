import { describe, expect, it, beforeEach, vi } from "vitest";
import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import { PluginDashboardViewHost, getPluginViewComponent, isPluginViewRegistered, __test_clearPluginViewRegistry } from "../pluginViewRegistry";
import {
  __test_resetBundledPluginViewRegistration,
  registerBundledPluginViews,
} from "../registerBundledPluginViews";

const MockDependencyGraphDashboardView = (_props?: unknown) => createElement("div", { "data-testid": "dep-graph-view" });
const MockCompoundEngineeringDashboardView = (_props?: unknown) => createElement("div", { "data-testid": "ce-view" });
const MockCliPrintingPressWizardView = (_props?: unknown) => createElement("div", { "data-testid": "cli-printing-press-view" });
const MockCliPrintingPressManageView = (_props?: unknown) => createElement("div", { "data-testid": "cli-printing-press-manage-view" });
const MockLinearImportView = (_props?: unknown) => createElement("div", { "data-testid": "linear-import-view" });
const MockTodoDashboardView = (_props?: unknown) => createElement("div", { "data-testid": "todos-view" });
const MockRoadmapDashboardView = (_props?: unknown) => createElement("div", { "data-testid": "roadmaps-view" });
const MockQualityDashboardView = (_props?: unknown) => createElement("div", { "data-testid": "quality-view" });

vi.mock("@fusion-plugin-examples/dependency-graph/dashboard-view", () => ({
  DependencyGraphDashboardView: (_props: unknown) => MockDependencyGraphDashboardView(_props),
}));

vi.mock("@fusion-plugin-examples/compound-engineering/dashboard-view", () => ({
  CompoundEngineeringDashboardView: (_props: unknown) => MockCompoundEngineeringDashboardView(_props),
}));

vi.mock("@fusion-plugin-examples/cli-printing-press/dashboard-view", () => ({
  CliPrintingPressWizardView: (_props: unknown) => MockCliPrintingPressWizardView(_props),
}));

vi.mock("@fusion-plugin-examples/cli-printing-press/manage-view", () => ({
  CliPrintingPressManageView: (_props: unknown) => MockCliPrintingPressManageView(_props),
}));

vi.mock("@fusion-plugin-examples/linear-import/dashboard-view", () => ({
  LinearImportDashboardView: (_props: unknown) => MockLinearImportView(_props),
}));

vi.mock("@fusion-plugin-examples/todos/dashboard-view", () => ({
  TodoDashboardView: (_props: unknown) => MockTodoDashboardView(_props),
}));

vi.mock("@fusion-plugin-examples/roadmap/dashboard-view", () => ({
  RoadmapDashboardView: (_props: unknown) => MockRoadmapDashboardView(_props),
}));

vi.mock("@fusion-plugin-examples/quality/dashboard-view", () => ({
  QualityDashboardView: (_props: unknown) => MockQualityDashboardView(_props),
}));

// The dashboard statically registers bundled views client-side, so these views can
// render even when engine-side PluginLoader startup failed and the persisted
// installation row is in an error state.
describe("registerBundledPluginViews", () => {
  beforeEach(() => {
    __test_clearPluginViewRegistry();
    __test_resetBundledPluginViewRegistration();
  });

  it("registers dependency graph, compound engineering, cli printing press, Linear, and roadmaps bundled views", () => {
    registerBundledPluginViews();

    // This registration is independent of engine-side plugin load success; the
    // dashboard can still render the Graph view while the plugin install row is errored.
    expect(isPluginViewRegistered("fusion-plugin-dependency-graph", "graph")).toBe(true);
    expect(getPluginViewComponent("fusion-plugin-dependency-graph", "graph")).toBeTruthy();
    expect(isPluginViewRegistered("fusion-plugin-compound-engineering", "compound-engineering")).toBe(true);
    expect(getPluginViewComponent("fusion-plugin-compound-engineering", "compound-engineering")).toBeTruthy();
    expect(getPluginViewComponent("fusion-plugin-roadmap", "roadmaps")).toBeTruthy();
    expect(getPluginViewComponent("fusion-plugin-todos", "todos")).toBeTruthy();
    expect(getPluginViewComponent("fusion-plugin-cli-printing-press", "wizard")).toBeTruthy();
    expect(getPluginViewComponent("fusion-plugin-cli-printing-press", "manage")).toBeTruthy();
    expect(getPluginViewComponent("fusion-plugin-linear-import", "linear-import")).toBeTruthy();
    expect(getPluginViewComponent("fusion-plugin-quality", "quality")).toBeTruthy();
    // Reports ships plugin UI but remains intentionally absent from the dashboard registry until enabled by its owning rollout.
    expect(getPluginViewComponent("fusion-plugin-reports", "reports")).toBeNull();
  });

  it("hosts the bundled Todo view instead of the unavailable fallback", async () => {
    registerBundledPluginViews();
    render(<>{PluginDashboardViewHost({ viewId: "plugin:fusion-plugin-todos:todos" })}</>);
    expect(await screen.findByTestId("todos-view")).toBeInTheDocument();
    expect(screen.queryByTestId("plugin-view-unavailable")).toBeNull();
  });

  it("hosts the bundled roadmaps view instead of the unavailable fallback", async () => {
    registerBundledPluginViews();

    render(<>{PluginDashboardViewHost({ viewId: "plugin:fusion-plugin-roadmap:roadmaps" })}</>);

    expect(await screen.findByTestId("roadmaps-view")).toBeInTheDocument();
    expect(screen.queryByTestId("plugin-view-unavailable")).toBeNull();
  });

  it("is idempotent when called more than once", () => {
    registerBundledPluginViews();
    const firstGraph = getPluginViewComponent("fusion-plugin-dependency-graph", "graph");

    expect(() => registerBundledPluginViews()).not.toThrow();
    expect(getPluginViewComponent("fusion-plugin-dependency-graph", "graph")).toBe(firstGraph);
  });

  // FN-3916 regression: verifies the registry reports the graph view as registered
  // so App.tsx can fall back to bundled static registration when API has no views.
  it("reports dependency graph as registered via isPluginViewRegistered", () => {
    registerBundledPluginViews();

    expect(isPluginViewRegistered("fusion-plugin-dependency-graph", "graph")).toBe(true);
    expect(isPluginViewRegistered("fusion-plugin-compound-engineering", "compound-engineering")).toBe(true);
    expect(isPluginViewRegistered("fusion-plugin-roadmap", "roadmaps")).toBe(true);
    expect(isPluginViewRegistered("fusion-plugin-todos", "todos")).toBe(true);
    expect(isPluginViewRegistered("fusion-plugin-cli-printing-press", "wizard")).toBe(true);
    expect(isPluginViewRegistered("fusion-plugin-cli-printing-press", "manage")).toBe(true);
    expect(isPluginViewRegistered("fusion-plugin-linear-import", "linear-import")).toBe(true);
    expect(isPluginViewRegistered("fusion-plugin-quality", "quality")).toBe(true);
    expect(isPluginViewRegistered("fusion-plugin-reports", "reports")).toBe(false);
    // Unknown plugin/view should not be registered
    expect(isPluginViewRegistered("unknown-plugin", "unknown")).toBe(false);
  });
});
