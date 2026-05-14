import type { RetrySummary } from "./types.js";

export class RetryStormError extends Error {
  readonly category: string;

  readonly total: number;

  readonly cap: number;

  readonly breakdown: RetrySummary;

  constructor({ category, total, cap, breakdown }: { category: string; total: number; cap: number; breakdown: RetrySummary }) {
    super(`Retry storm: ${total} retries exceeds cap ${cap} (top category: ${category})`);
    this.name = "RetryStormError";
    this.category = category;
    this.total = total;
    this.cap = cap;
    this.breakdown = breakdown;
  }
}

export function serializeRetryStormError(err: RetryStormError): {
  type: "RetryStormError";
  category: string;
  total: number;
  cap: number;
  breakdown: RetrySummary;
} {
  return {
    type: "RetryStormError",
    category: err.category,
    total: err.total,
    cap: err.cap,
    breakdown: err.breakdown,
  };
}
