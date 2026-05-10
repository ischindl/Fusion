import { createElement, lazy, type ReactElement } from "react";
import type { ComponentType } from "react";
import type { PluginDashboardViewContext } from "./types";
import { registerPluginView } from "./pluginViewRegistry";

let registered = false;

type PluginViewComponent = ({ context }: { context?: PluginDashboardViewContext }) => ReactElement;

function createMissingPluginView(moduleId: string): PluginViewComponent {
  return function MissingPluginView() {
    return createElement("span", null, `Bundled plugin view unavailable: ${moduleId}`);
  };
}

async function loadBundledPluginView(moduleId: string, exportName: string): Promise<{ default: PluginViewComponent }> {
  try {
    const mod = await import(/* @vite-ignore */ moduleId) as Record<string, ComponentType<{ context?: PluginDashboardViewContext }>>;
    const component = mod[exportName];
    if (component) {
      return { default: component as PluginViewComponent };
    }
  } catch {
    // Fall back to placeholder view when optional bundled plugin examples are unavailable.
  }

  return { default: createMissingPluginView(moduleId) };
}

export function registerBundledPluginViews(): void {
  if (registered) return;
  registered = true;

  registerPluginView(
    "fusion-plugin-dependency-graph",
    "graph",
    lazy(() => loadBundledPluginView("@fusion-plugin-examples/dependency-graph/dashboard-view", "DependencyGraphDashboardView")),
  );

  registerPluginView(
    "roadmap-planner",
    "roadmaps",
    lazy(() => loadBundledPluginView("@fusion-plugin-examples/roadmap/dashboard-view", "RoadmapDashboardView")),
  );
}
