import type { CapacityRiskSignal } from "@fusion/core";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import "./CapacityRiskBanner.css";

interface CapacityRiskBannerProps {
  signal: CapacityRiskSignal | null;
  onDismiss?: () => void;
}

export function CapacityRiskBanner({ signal, onDismiss }: CapacityRiskBannerProps) {
  const { t } = useTranslation("app");
  if (!signal || !signal.atRisk) {
    return null;
  }

  return (
    <div className={`capacity-risk-banner${onDismiss ? " capacity-risk-banner--dismissible" : ""}`} role="status" aria-live="polite">
      <div className="capacity-risk-banner__content">
        <strong>{t("capacity.risk", "Capacity risk:")}</strong> {t("capacity.status", "Todo {{todoCount}} (threshold {{threshold}}) · In Progress {{inProgress}} · In Review {{inReview}} · Idle agents {{idleAgents}}", { todoCount: signal.todoCount, threshold: signal.threshold, inProgress: signal.inProgressCount, inReview: signal.inReviewCount, idleAgents: signal.idleNonEphemeralAgentCount })}
      </div>
      {onDismiss ? (
        <button
          type="button"
          className="capacity-risk-banner__dismiss touch-target"
          aria-label={t("capacity.dismiss", "Dismiss capacity warning")}
          onClick={onDismiss}
        >
          <X aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
