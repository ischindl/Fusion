import { useTranslation } from "react-i18next";
import { FlaskConical } from "lucide-react";
import "./TestModeBanner.css";

interface TestModeBannerProps {
  isActive: boolean;
}

export function TestModeBanner({ isActive }: TestModeBannerProps) {
  const { t } = useTranslation("app");
  if (!isActive) {
    return null;
  }

  return (
    <div className="test-mode-banner" role="status" aria-live="polite">
      <FlaskConical aria-hidden="true" />
      <span>{t("app.testMode", "Test mode — no real AI calls")}</span>
    </div>
  );
}
