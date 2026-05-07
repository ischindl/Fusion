import { describe, expect, it } from "vitest";
import { definePlugin } from "@fusion/plugin-sdk";
import { validatePluginManifest } from "@fusion/core";
import plugin from "../index";
import { getPluginViewId } from "../../../../packages/dashboard/app/plugins/pluginViewRegistry";

describe("dependency graph plugin host integration contract", () => {
  it("declares dashboard view manifest shape", () => {
    expect(plugin.manifest.id).toBe("fusion-plugin-dependency-graph");
    expect(plugin.dashboardViews).toEqual([
      expect.objectContaining({
        viewId: "graph",
        label: "Graph",
        componentPath: "./src/DependencyGraph.tsx",
        placement: "more",
      }),
    ]);
  });

  it("is valid for definePlugin + manifest validation", () => {
    const defined = definePlugin(plugin);
    const validation = validatePluginManifest(defined.manifest);

    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  it("produces loader-compatible pluginId/view entries", () => {
    const entries = (plugin.dashboardViews ?? []).map((view) => ({ pluginId: plugin.manifest.id, view }));

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        pluginId: "fusion-plugin-dependency-graph",
        view: expect.objectContaining({ viewId: "graph" }),
      }),
    );
  });

  it("matches host registry lookup key format plugin:{pluginId}:{viewId}", () => {
    const view = plugin.dashboardViews?.[0];
    if (!view) throw new Error("missing dashboard view");

    expect(getPluginViewId(plugin.manifest.id, view.viewId)).toBe("plugin:fusion-plugin-dependency-graph:graph");
  });
});
