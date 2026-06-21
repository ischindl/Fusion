/**
 * Shared phase chip for workflow steps (pre-merge / post-merge). Extracted from
 * WorkflowResultsTab so the node-editor optional-steps panel and the optional-step
 * dropdown render an identical badge without duplicating markup.
 */
import type { ReactNode } from "react";
import type { useTranslation } from "react-i18next";

export function phaseBadge(
  phase: "pre-merge" | "post-merge",
  id: string,
  prefix: string,
  t: ReturnType<typeof useTranslation>["t"],
): ReactNode {
  const phaseClass = phase === "post-merge" ? "phase-badge--post-merge" : "phase-badge--pre-merge";
  return (
    <span className={`phase-badge ${phaseClass}`} data-testid={`${prefix}-${id}`}>
      {phase === "post-merge"
        ? t("app:workflow.postMerge", "Post-merge")
        : t("app:workflow.preMerge", "Pre-merge")}
    </span>
  );
}
