import { lazy } from "react";
import type { ComponentType } from "react";
import { registerPluginView } from "./pluginViewRegistry";

let registered = false;

function createMissingPluginView(moduleId: string): ComponentType {
  return function MissingPluginView() {
    return `Bundled plugin view unavailable: ${moduleId}`;
  };
}

async function loadBundledPluginView(moduleId: string, exportName: string) {
  try {
    const mod = await import(/* @vite-ignore */ moduleId) as Record<string, ComponentType>;
    const component = mod[exportName];
    if (component) {
      return { default: component };
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
