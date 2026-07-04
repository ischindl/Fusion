import "./SetupWarningBanner.css";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";

interface SetupWarningBannerProps {
  /** Whether an AI provider is connected */
  hasAiProvider: boolean;
  /** Whether GitHub is connected */
  hasGithub: boolean;
  /** Whether the GitHub warning item is allowed to render after any grace period */
  showGithubWarning?: boolean;
  /** Optional: compact mode for inline use (QuickEntryBox) */
  compact?: boolean;
  /** Optional callback to open GitHub/authentication setup */
  onConnectGithub?: () => void;
  /** Optional callback to dismiss the banner */
  onDismiss?: () => void;
}

interface WarningItem {
  key: "ai" | "github";
  title: string;
  description: string;
}

export function SetupWarningBanner({
  hasAiProvider,
  hasGithub,
  showGithubWarning = !hasGithub,
  compact = false,
  onDismiss,
  onConnectGithub,
}: SetupWarningBannerProps) {
  const { t } = useTranslation("app");
  const shouldShowGithubWarning = !hasGithub && showGithubWarning;
  if (hasAiProvider && !shouldShowGithubWarning) {
    return null;
  }

  const dismissButton = onDismiss ? (
    <button
      type="button"
      className="setup-warning-banner__dismiss touch-target"
      aria-label={t("setup.dismissWarning", "Dismiss setup warning")}
      onClick={onDismiss}
    >
      <X size={16} aria-hidden="true" />
    </button>
  ) : null;

  if (compact) {
    return (
      <div
        className={`setup-warning-banner setup-warning-banner--compact${onDismiss ? " setup-warning-banner--dismissible" : ""}`}
        role="status"
        aria-live="polite"
      >
        <p className="setup-warning-banner__compact-text">
          {t("setup.compactWarning", "⚠ Setup incomplete — AI and/or GitHub features will be limited.")}
        </p>
        {dismissButton}
      </div>
    );
  }

  const warningItems: WarningItem[] = [];

  if (!hasAiProvider) {
    warningItems.push({
      key: "ai",
      title: t("setup.noAiProvider", "No AI provider connected"),
      description: t("setup.noAiProviderDesc", "AI agents won't be able to work on tasks until you connect a provider. Set one up in Settings → AI Setup."),
    });
  }

  if (shouldShowGithubWarning) {
    warningItems.push({
      key: "github",
      title: t("setup.noGithub", "GitHub not connected"),
      description: t("setup.noGithubDesc", "You won't be able to import issues from GitHub, but you can still create tasks manually."),
    });
  }

  return (
    <div
      className={`setup-warning-banner${onDismiss ? " setup-warning-banner--dismissible" : ""}`}
      role="status"
      aria-live="polite"
    >
      {dismissButton}
      {warningItems.map((warning) => (
        <div key={warning.key} className="setup-warning-banner__item">
          <strong className="setup-warning-banner__title">{warning.title}</strong>
          <p className="setup-warning-banner__description">{warning.description}</p>
          {warning.key === "github" && onConnectGithub ? (
            <div className="setup-warning-banner__actions">
              <button type="button" className="btn btn-sm btn-primary" onClick={onConnectGithub}>
                {t("setup.connectGithub", "Connect GitHub")}
              </button>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
