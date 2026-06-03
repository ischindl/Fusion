import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginRouteResponse } from "@fusion/core";
import { createArtifactRoutes } from "../artifact-routes.js";
import { makeHarness, type TestHarness } from "../../__tests__/_harness.js";

function route(path: string, method = "GET") {
  const def = createArtifactRoutes().find((r) => r.path === path && r.method === method);
  if (!def) throw new Error(`route not found: ${method} ${path}`);
  return def;
}

describe("artifact routes", () => {
  let h: TestHarness;

  afterEach(() => h?.close());

  it("GET /artifacts lists discovered artifacts grouped by stage", async () => {
    h = makeHarness();
    writeFileSync(join(h.projectRoot, "STRATEGY.md"), "# Strategy");
    mkdirSync(join(h.projectRoot, "docs/plans"), { recursive: true });
    writeFileSync(join(h.projectRoot, "docs/plans/p.md"), "plan body");

    const res = (await route("/artifacts").handler({ query: {} }, h.ctx)) as PluginRouteResponse;
    expect(res.status).toBe(200);
    const body = res.body as { totalArtifacts: number; groups: Array<{ stage: string; entries: unknown[] }> };
    expect(body.totalArtifacts).toBe(2);
    const plan = body.groups.find((g) => g.stage === "plan")!;
    expect(plan.entries).toHaveLength(1);
  });

  it("GET /artifacts/:id returns raw content", async () => {
    h = makeHarness();
    writeFileSync(join(h.projectRoot, "STRATEGY.md"), "# Strategy body");

    const res = (await route("/artifacts/:id").handler(
      { params: { id: encodeURIComponent("strategy:STRATEGY.md") }, query: {} },
      h.ctx,
    )) as PluginRouteResponse;
    expect(res.status).toBe(200);
    expect((res.body as { content: string }).content).toContain("Strategy body");
  });

  it("GET /artifacts/:id 404s an unknown id", async () => {
    h = makeHarness();
    const res = (await route("/artifacts/:id").handler(
      { params: { id: encodeURIComponent("strategy:STRATEGY.md") }, query: {} },
      h.ctx,
    )) as PluginRouteResponse;
    expect(res.status).toBe(404);
  });

  it("GET /artifacts/:id/preview.html returns a self-contained, escaped HTML document", async () => {
    h = makeHarness();
    // Content with an injection attempt — must be escaped, not executed.
    writeFileSync(join(h.projectRoot, "STRATEGY.md"), "<script>alert('x')</script>\n# Plan");

    const res = (await route("/artifacts/:id/preview.html").handler(
      { params: { id: encodeURIComponent("strategy:STRATEGY.md") }, query: {} },
      h.ctx,
    )) as PluginRouteResponse;

    expect(res.status).toBe(200);
    expect(res.contentType).toContain("text/html");
    const html = res.body as string;
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    // Self-contained: inlined <style>, no remote asset URLs.
    expect(html).toContain("<style>");
    expect(html).not.toMatch(/https?:\/\//);
    // data-section markers present (reports rendering contract).
    expect(html).toContain('data-section="content"');
    // The raw script tag is escaped, not embedded as live markup.
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
  });
});
