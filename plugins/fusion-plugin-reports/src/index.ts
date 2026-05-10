import type { PluginContext } from "@fusion/core";
import { definePlugin } from "@fusion/plugin-sdk";
import { runReviewPanel } from "./review-panel.js";
import { ensureReportSchema } from "./report-schema.js";
import { createReportExportRoutes } from "./routes/report-export-routes.js";
import type { CombinedReview, ReviewPanelMember, RunReviewPanelInput } from "./review-types.js";
import type { ReportCadence, ReportCreateInput } from "./store/report-types.js";
import { ReportStore } from "./store/report-store.js";
import { settingsSchema } from "./settings.js";

const plugin = definePlugin({
  manifest: {
    id: "fusion-plugin-reports",
    name: "Reports",
    version: "0.1.0",
    description: "Generates beautiful HTML system-activity reports with multi-agent review.",
    author: "Fusion Team",
    fusionVersion: ">=0.1.0",
    settingsSchema,
  },
  state: "installed",
  hooks: {
    onSchemaInit: ensureReportSchema,
  },
  routes: createReportExportRoutes(),
});

export interface RunGeneratedReportReviewInput {
  reportDraft: string;
  reportMetadata: RunReviewPanelInput["reportMetadata"];
  panel: ReviewPanelMember[];
  cwd: string;
}

const reportStoreCache = new WeakMap<object, ReportStore>();

export function getReportStore(ctx: PluginContext): ReportStore {
  const key = ctx.taskStore as object;
  const cached = reportStoreCache.get(key);
  if (cached) return cached;

  const store = new ReportStore(ctx.taskStore.getDatabase());
  reportStoreCache.set(key, store);
  return store;
}

function toCadence(cadence: RunReviewPanelInput["reportMetadata"]["cadence"]): ReportCadence {
  return cadence;
}

export async function runGeneratedReportReview(input: RunGeneratedReportReviewInput, ctx: PluginContext): Promise<CombinedReview> {
  const store = getReportStore(ctx);
  const reportInput: ReportCreateInput = {
    cadence: toCadence(input.reportMetadata.cadence),
    periodStart: input.reportMetadata.periodStart,
    periodEnd: input.reportMetadata.periodEnd,
    title: `Generated ${input.reportMetadata.cadence} report`,
    draftMarkdown: input.reportDraft,
    metadata: {
      reportMetadata: input.reportMetadata,
      source: "runGeneratedReportReview",
    },
  };
  const report = store.createReport(reportInput);
  store.setStatus(report.id, "review_pending");
  store.setStatus(report.id, "review_in_progress");

  const combinedReview = await runReviewPanel({
    reportDraft: input.reportDraft,
    reportMetadata: {
      ...input.reportMetadata,
      reportId: report.id,
    },
    panel: input.panel,
    cwd: input.cwd,
  }, ctx);

  store.attachReview(report.id, combinedReview);
  return combinedReview;
}

export default plugin;

export * from "./settings.js";
export * from "./review-types.js";
export * from "./review-panel.js";
export { ensureReportSchema } from "./report-schema.js";
export { ReportStore, ReportStoreError, type ReportStoreEvents } from "./store/report-store.js";
export * from "./store/report-types.js";
export * from "./render/index.js";
