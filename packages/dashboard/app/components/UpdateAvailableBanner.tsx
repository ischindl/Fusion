import "./UpdateAvailableBanner.css";
import { X } from "lucide-react";
import { useTranslation, Trans } from "react-i18next";

interface UpdateAvailableBannerProps {
  latestVersion: string;
  currentVersion: string;
  onDismiss: () => void;
}

export function UpdateAvailableBanner({ latestVersion, currentVersion, onDismiss }: UpdateAvailableBannerProps) {
  const { t } = useTranslation("app");

  return (
    <div className="update-available-banner" role="status" aria-live="polite">
      <p className="update-available-banner__text">
        <Trans
          i18nKey="app:updateBanner.message"
          defaults="Update available: v{{latestVersion}} (current: v{{currentVersion}}). Run <code>fn update</code> for an installed CLI, or pull this source checkout."
          values={{ latestVersion, currentVersion }}
          components={{ code: <code /> }}
        />{" "}
        <a
          className="update-available-banner__link"
          href="https://github.com/Runfusion/Fusion/blob/main/CHANGELOG.md"
          target="_blank"
          rel="noreferrer"
        >
          {t("updateBanner.releaseNotes", "Release notes")}
        </a>{" "}
        ·{" "}
        <a className="update-available-banner__link" href="https://runfusion.ai" target="_blank" rel="noreferrer">
          {t("updateBanner.learnMore", "Learn more")}
        </a>
      </p>
      <button
        type="button"
        className="update-available-banner__dismiss touch-target"
        aria-label={t("updateBanner.dismissLabel", "Dismiss update notice")}
        onClick={onDismiss}
      >
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
