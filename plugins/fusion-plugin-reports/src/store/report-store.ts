import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Database } from "@fusion/core";
import type { CombinedReview } from "../review-types.js";
import {
  type Report,
  type ReportCreateInput,
  type ReportListFilter,
  type ReportStatus,
  type ReportUpdateInput,
  isValidReportStatusTransition,
} from "./report-types.js";

interface ReportRow {
  id: string;
  cadence: Report["cadence"];
  periodStart: string;
  periodEnd: string;
  title: string;
  status: ReportStatus;
  generationStartedAt: string;
  generationCompletedAt: string | null;
  reviewStartedAt: string | null;
  reviewCompletedAt: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  publishedAt: string | null;
  archivedAt: string | null;
  failureReason: string | null;
  draftMarkdown: string | null;
  renderedHtmlPath: string | null;
  rendered_html: string | null;
  rendered_html_generated_at: string | null;
  metadataJson: string;
  combinedReviewJson: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReportStoreEvents {
  "report:created": [Report];
  "report:updated": [Report];
  "report:status-changed": [Report];
  "report:review-attached": [Report];
  "report:deleted": [string];
}

export class ReportStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportStoreError";
  }
}

export class ReportStore extends EventEmitter<ReportStoreEvents> {
  constructor(private readonly db: Database) {
    super();
    this.setMaxListeners(50);
  }

  createReport(input: ReportCreateInput): Report {
    const now = new Date().toISOString();
    const report: Report = {
      id: `rep_${randomUUID().replaceAll("-", "")}`,
      cadence: input.cadence,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      title: input.title,
      status: "generating",
      generationStartedAt: now,
      generationCompletedAt: null,
      reviewStartedAt: null,
      reviewCompletedAt: null,
      approvedAt: null,
      approvedBy: null,
      publishedAt: null,
      archivedAt: null,
      failureReason: null,
      draftMarkdown: input.draftMarkdown ?? null,
      renderedHtmlPath: null,
      renderedHtml: null,
      renderedHtmlGeneratedAt: null,
      metadata: input.metadata ?? {},
      combinedReview: null,
      createdAt: now,
      updatedAt: now,
    };

    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO reports (
          id, cadence, periodStart, periodEnd, title, status,
          generationStartedAt, generationCompletedAt, reviewStartedAt, reviewCompletedAt,
          approvedAt, approvedBy, publishedAt, archivedAt, failureReason,
          draftMarkdown, renderedHtmlPath, rendered_html, rendered_html_generated_at, metadataJson, combinedReviewJson, createdAt, updatedAt
        ) VALUES (
          @id, @cadence, @periodStart, @periodEnd, @title, @status,
          @generationStartedAt, @generationCompletedAt, @reviewStartedAt, @reviewCompletedAt,
          @approvedAt, @approvedBy, @publishedAt, @archivedAt, @failureReason,
          @draftMarkdown, @renderedHtmlPath, @renderedHtml, @renderedHtmlGeneratedAt, @metadataJson, @combinedReviewJson, @createdAt, @updatedAt
        )
      `).run(this.toDbParams(report, true));
    });

    this.db.bumpLastModified();
    this.emit("report:created", report);
    return report;
  }

  getReport(id: string): Report | null {
    const row = this.db.prepare("SELECT * FROM reports WHERE id = ?").get(id) as ReportRow | undefined;
    return row ? this.rowToReport(row) : null;
  }

  listReports(filter: ReportListFilter = {}): Report[] {
    const params: unknown[] = [];
    const where: string[] = [];

    if (filter.cadence) {
      where.push("cadence = ?");
      params.push(filter.cadence);
    }
    if (filter.statusIn && filter.statusIn.length > 0) {
      where.push(`status IN (${filter.statusIn.map(() => "?").join(",")})`);
      params.push(...filter.statusIn);
    } else if (filter.status) {
      where.push("status = ?");
      params.push(filter.status);
    }
    if (filter.periodStartFrom) {
      where.push("periodStart >= ?");
      params.push(filter.periodStartFrom);
    }
    if (filter.periodStartTo) {
      where.push("periodStart <= ?");
      params.push(filter.periodStartTo);
    }

    const orderBy = filter.orderBy === "periodStart" ? "periodStart" : "createdAt";
    const orderDir = filter.orderDir === "asc" ? "ASC" : "DESC";
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    const offset = Math.max(filter.offset ?? 0, 0);

    const sql = `
      SELECT * FROM reports
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY ${orderBy} ${orderDir}, id ${orderDir}
      LIMIT ? OFFSET ?
    `;
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as ReportRow[];
    return rows.map((row) => this.rowToReport(row));
  }

  updateReport(id: string, patch: ReportUpdateInput): Report {
    const current = this.requireReport(id);
    const next: Report = {
      ...current,
      title: patch.title ?? current.title,
      draftMarkdown: patch.draftMarkdown ?? current.draftMarkdown,
      renderedHtmlPath: patch.renderedHtmlPath ?? current.renderedHtmlPath,
      metadata: patch.metadata ?? current.metadata,
      renderedHtml: patch.renderedHtml ?? current.renderedHtml,
      renderedHtmlGeneratedAt: patch.renderedHtmlGeneratedAt ?? current.renderedHtmlGeneratedAt,
      failureReason: patch.failureReason ?? current.failureReason,
      updatedAt: new Date().toISOString(),
    };

    this.db.transaction(() => this.persistExisting(next));
    this.db.bumpLastModified();
    this.emit("report:updated", next);
    return next;
  }

  setStatus(id: string, next: ReportStatus, opts: { failureReason?: string; approvedBy?: string } = {}): Report {
    const current = this.requireReport(id);
    if (current.status === next) return current;
    if (!isValidReportStatusTransition(current.status, next)) {
      throw new ReportStoreError(`Invalid status transition: ${current.status} -> ${next}`);
    }

    const now = new Date().toISOString();
    const updated: Report = {
      ...current,
      status: next,
      updatedAt: now,
      failureReason: next === "failed" ? (opts.failureReason ?? current.failureReason) : current.failureReason,
    };

    if (next === "review_pending") updated.generationCompletedAt = now;
    if (next === "review_in_progress") updated.reviewStartedAt = now;
    if (next === "review_complete") updated.reviewCompletedAt = now;
    if (next === "approved") {
      updated.approvedAt = now;
      updated.approvedBy = opts.approvedBy ?? current.approvedBy;
    }
    if (next === "published") updated.publishedAt = now;
    if (next === "archived") updated.archivedAt = now;

    this.db.transaction(() => this.persistExisting(updated));
    this.db.bumpLastModified();
    this.emit("report:status-changed", updated);
    return updated;
  }

  attachReview(id: string, combined: CombinedReview): Report {
    const current = this.requireReport(id);
    if (current.status !== "review_in_progress") {
      throw new ReportStoreError(`attachReview requires review_in_progress status; got ${current.status}`);
    }

    const now = new Date().toISOString();
    const updated: Report = {
      ...current,
      combinedReview: combined,
      status: "review_complete",
      reviewCompletedAt: now,
      updatedAt: now,
    };

    this.db.transaction(() => this.persistExisting(updated));
    this.db.bumpLastModified();
    this.emit("report:review-attached", updated);
    this.emit("report:status-changed", updated);
    return updated;
  }

  attachRenderedHtml(id: string, htmlPath: string): Report {
    return this.updateReport(id, { renderedHtmlPath: htmlPath });
  }

  setRenderedHtml(id: string, html: string): Report {
    return this.updateReport(id, {
      renderedHtml: html,
      renderedHtmlGeneratedAt: new Date().toISOString(),
    });
  }

  deleteReport(id: string): void {
    this.requireReport(id);
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM reports WHERE id = ?").run(id);
    });
    this.db.bumpLastModified();
    this.emit("report:deleted", id);
  }

  private requireReport(id: string): Report {
    const report = this.getReport(id);
    if (!report) throw new ReportStoreError(`Report ${id} not found`);
    return report;
  }

  private rowToReport(row: ReportRow): Report {
    return {
      id: row.id,
      cadence: row.cadence,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      title: row.title,
      status: row.status,
      generationStartedAt: row.generationStartedAt,
      generationCompletedAt: row.generationCompletedAt,
      reviewStartedAt: row.reviewStartedAt,
      reviewCompletedAt: row.reviewCompletedAt,
      approvedAt: row.approvedAt,
      approvedBy: row.approvedBy,
      publishedAt: row.publishedAt,
      archivedAt: row.archivedAt,
      failureReason: row.failureReason,
      draftMarkdown: row.draftMarkdown,
      renderedHtmlPath: row.renderedHtmlPath,
      renderedHtml: row.rendered_html,
      renderedHtmlGeneratedAt: row.rendered_html_generated_at,
      metadata: this.parseMetadata(row.metadataJson),
      combinedReview: this.parseCombinedReview(row.combinedReviewJson),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private persistExisting(report: Report): void {
    const result = this.db.prepare(`
      UPDATE reports
      SET cadence = @cadence,
          periodStart = @periodStart,
          periodEnd = @periodEnd,
          title = @title,
          status = @status,
          generationStartedAt = @generationStartedAt,
          generationCompletedAt = @generationCompletedAt,
          reviewStartedAt = @reviewStartedAt,
          reviewCompletedAt = @reviewCompletedAt,
          approvedAt = @approvedAt,
          approvedBy = @approvedBy,
          publishedAt = @publishedAt,
          archivedAt = @archivedAt,
          failureReason = @failureReason,
          draftMarkdown = @draftMarkdown,
          renderedHtmlPath = @renderedHtmlPath,
          rendered_html = @renderedHtml,
          rendered_html_generated_at = @renderedHtmlGeneratedAt,
          metadataJson = @metadataJson,
          combinedReviewJson = @combinedReviewJson,
          updatedAt = @updatedAt
      WHERE id = @id
    `).run(this.toDbParams(report, false));

    if (result.changes === 0) {
      throw new ReportStoreError(`Report ${report.id} not found`);
    }
  }

  private toDbParams(report: Report, includeCreatedAt: boolean): Record<string, unknown> {
    return {
      id: report.id,
      cadence: report.cadence,
      periodStart: report.periodStart,
      periodEnd: report.periodEnd,
      title: report.title,
      status: report.status,
      generationStartedAt: report.generationStartedAt,
      generationCompletedAt: report.generationCompletedAt,
      reviewStartedAt: report.reviewStartedAt,
      reviewCompletedAt: report.reviewCompletedAt,
      approvedAt: report.approvedAt,
      approvedBy: report.approvedBy,
      publishedAt: report.publishedAt,
      archivedAt: report.archivedAt,
      failureReason: report.failureReason,
      draftMarkdown: report.draftMarkdown,
      renderedHtmlPath: report.renderedHtmlPath,
      renderedHtml: report.renderedHtml,
      renderedHtmlGeneratedAt: report.renderedHtmlGeneratedAt,
      metadataJson: JSON.stringify(report.metadata ?? {}),
      combinedReviewJson: report.combinedReview ? JSON.stringify(report.combinedReview) : null,
      ...(includeCreatedAt ? { createdAt: report.createdAt } : {}),
      updatedAt: report.updatedAt,
    };
  }

  private parseMetadata(json: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(json);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }

  private parseCombinedReview(json: string | null): CombinedReview | null {
    if (!json) return null;
    try {
      return JSON.parse(json) as CombinedReview;
    } catch {
      return null;
    }
  }
}
