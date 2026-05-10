import type { Database } from "@fusion/core";

export function ensureReportSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      cadence TEXT NOT NULL CHECK (cadence IN ('daily','weekly','monthly','quarterly','manual')),
      periodStart TEXT NOT NULL,
      periodEnd TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('generating','review_pending','review_in_progress','review_complete','approved','published','archived','failed')),
      generationStartedAt TEXT NOT NULL,
      generationCompletedAt TEXT,
      reviewStartedAt TEXT,
      reviewCompletedAt TEXT,
      approvedAt TEXT,
      approvedBy TEXT,
      publishedAt TEXT,
      archivedAt TEXT,
      failureReason TEXT,
      draftMarkdown TEXT,
      renderedHtmlPath TEXT,
      rendered_html TEXT,
      rendered_html_generated_at TEXT,
      metadataJson TEXT NOT NULL DEFAULT '{}',
      combinedReviewJson TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idxReportsCadenceCreated
      ON reports(cadence, createdAt DESC, id);

    CREATE INDEX IF NOT EXISTS idxReportsStatusUpdated
      ON reports(status, updatedAt DESC, id);

    CREATE INDEX IF NOT EXISTS idxReportsPeriod
      ON reports(periodStart, periodEnd, id);
  `);

  const columns = db.prepare("PRAGMA table_info(reports)").all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has("rendered_html")) {
    db.exec("ALTER TABLE reports ADD COLUMN rendered_html TEXT");
  }
  if (!names.has("rendered_html_generated_at")) {
    db.exec("ALTER TABLE reports ADD COLUMN rendered_html_generated_at TEXT");
  }
}
