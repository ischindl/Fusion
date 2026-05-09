import { Database } from "@fusion/core";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureReportSchema } from "../../report-schema.js";
import type { CombinedReview } from "../../review-types.js";
import { ReportStore, ReportStoreError } from "../report-store.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "report-store-test-"));
}

function makeReview(): CombinedReview {
  return {
    overallVerdict: "revise",
    consensusSummary: "Needs updates",
    mergedHighlights: ["Good structure"],
    mergedLowlights: ["Missing metrics"],
    mergedSuggestions: ["Add numbers"],
    individual: [],
    failures: [],
  };
}

describe("ReportStore", () => {
  let tmp: string;
  let db: Database;
  let store: ReportStore;

  beforeEach(() => {
    tmp = makeTmpDir();
    db = new Database(join(tmp, ".fusion"), { inMemory: true });
    db.init();
    ensureReportSchema(db);
    store = new ReportStore(db);
  });

  afterEach(async () => {
    db.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("createReport persists generating report", () => {
    const listener = vi.fn();
    store.on("report:created", listener);

    const report = store.createReport({
      cadence: "daily",
      periodStart: "2026-05-01T00:00:00.000Z",
      periodEnd: "2026-05-01T23:59:59.999Z",
      title: "Daily",
      metadata: { sourceCount: 12 },
      draftMarkdown: "# Draft",
    });

    expect(report.id).toMatch(/^rep_/);
    expect(report.status).toBe("generating");
    expect(report.generationStartedAt).toBeTruthy();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getReport(report.id)?.metadata).toEqual({ sourceCount: 12 });
  });

  it("getReport hydrates metadata and combinedReview", () => {
    const report = store.createReport({ cadence: "weekly", periodStart: "2026-05-01", periodEnd: "2026-05-07", title: "Weekly" });
    store.setStatus(report.id, "review_pending");
    store.setStatus(report.id, "review_in_progress");
    store.attachReview(report.id, makeReview());

    const hydrated = store.getReport(report.id);
    expect(hydrated?.combinedReview?.overallVerdict).toBe("revise");
    expect(hydrated?.metadata).toEqual({});
  });

  it("listReports filters and paginates", () => {
    const a = store.createReport({ cadence: "daily", periodStart: "2026-05-01", periodEnd: "2026-05-01", title: "A" });
    const b = store.createReport({ cadence: "weekly", periodStart: "2026-05-02", periodEnd: "2026-05-08", title: "B" });
    const c = store.createReport({ cadence: "daily", periodStart: "2026-05-03", periodEnd: "2026-05-03", title: "C" });
    store.setStatus(c.id, "failed", { failureReason: "x" });

    expect(store.listReports({ cadence: "daily" }).length).toBe(2);
    expect(store.listReports({ statusIn: ["failed"] }).map((r) => r.id)).toEqual([c.id]);
    expect(store.listReports({ periodStartFrom: "2026-05-02", periodStartTo: "2026-05-03", orderBy: "periodStart", orderDir: "asc" }).map((r) => r.id)).toEqual([b.id, c.id]);

    const paged = store.listReports({ orderBy: "periodStart", orderDir: "asc", limit: 1, offset: 1 });
    expect(paged).toHaveLength(1);
  });

  it("setStatus enforces lifecycle and timestamps", () => {
    const report = store.createReport({ cadence: "daily", periodStart: "2026-05-01", periodEnd: "2026-05-01", title: "A" });

    const pending = store.setStatus(report.id, "review_pending");
    expect(pending.generationCompletedAt).toBeTruthy();

    const inProgress = store.setStatus(report.id, "review_in_progress");
    expect(inProgress.reviewStartedAt).toBeTruthy();

    const complete = store.setStatus(report.id, "review_complete");
    expect(complete.reviewCompletedAt).toBeTruthy();

    const approved = store.setStatus(report.id, "approved", { approvedBy: "agent-1" });
    expect(approved.approvedAt).toBeTruthy();
    expect(approved.approvedBy).toBe("agent-1");

    const published = store.setStatus(report.id, "published");
    expect(published.publishedAt).toBeTruthy();

    expect(() => store.setStatus(report.id, "generating")).toThrow(ReportStoreError);
  });

  it("setStatus failed works from non-terminal state and saves failureReason", () => {
    const report = store.createReport({ cadence: "daily", periodStart: "2026-05-01", periodEnd: "2026-05-01", title: "A" });
    const failed = store.setStatus(report.id, "failed", { failureReason: "timeout" });
    expect(failed.failureReason).toBe("timeout");
  });

  it("attachRenderedHtml and deleteReport persist and emit events", () => {
    const report = store.createReport({ cadence: "manual", periodStart: "2026-05-01", periodEnd: "2026-05-01", title: "A" });
    const deleted = vi.fn();
    store.on("report:deleted", deleted);

    const updated = store.attachRenderedHtml(report.id, ".fusion/plugins/reports/report.html");
    expect(updated.renderedHtmlPath).toContain("report.html");

    store.deleteReport(report.id);
    expect(store.getReport(report.id)).toBeNull();
    expect(deleted).toHaveBeenCalledWith(report.id);
  });

  it("emits events once for update/status/review", () => {
    const report = store.createReport({ cadence: "daily", periodStart: "2026-05-01", periodEnd: "2026-05-01", title: "A" });
    const updated = vi.fn();
    const status = vi.fn();
    const review = vi.fn();
    store.on("report:updated", updated);
    store.on("report:status-changed", status);
    store.on("report:review-attached", review);

    store.updateReport(report.id, { title: "B" });
    store.setStatus(report.id, "review_pending");
    store.setStatus(report.id, "review_in_progress");
    store.attachReview(report.id, makeReview());

    expect(updated).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledTimes(3);
    expect(review).toHaveBeenCalledTimes(1);
  });

  it("rolls back failed transaction and commits successful transaction", () => {
    const report = store.createReport({ cadence: "daily", periodStart: "2026-05-01", periodEnd: "2026-05-01", title: "A" });

    const originalPrepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      const stmt = originalPrepare(sql);
      if (sql.includes("UPDATE reports") && !sql.includes("WHERE id = @id")) {
        return stmt;
      }
      if (sql.includes("UPDATE reports")) {
        return {
          ...stmt,
          run: (...args: unknown[]) => {
            throw new Error("forced failure");
          },
        } as typeof stmt;
      }
      return stmt;
    });

    expect(() => store.updateReport(report.id, { title: "Broken" })).toThrow("forced failure");
    expect(store.getReport(report.id)?.title).toBe("A");

    spy.mockRestore();
    const ok = store.updateReport(report.id, { title: "Good" });
    expect(ok.title).toBe("Good");
  });
});
