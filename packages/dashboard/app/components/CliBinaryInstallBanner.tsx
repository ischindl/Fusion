import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import {
  fetchFnBinaryStatus,
  installFnBinary,
  type FnBinaryStatus,
} from "../api/legacy";
import "./CliBinaryInstallBanner.css";

interface Props {
  /** Open Settings → General so the user can manage manually. */
  onOpenSettings: () => void;
}

/** localStorage key for permanent dismissal. */
const DISMISS_KEY = "fusion:cli-binary-banner-dismissed";

function isDismissed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function persistDismissal(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DISMISS_KEY, "1");
  } catch {
    // Ignore quota / private-mode errors — dismissal lasts the session only.
  }
}

/**
 * One-time banner that nudges users to install the global `fn`/`fusion`
 * CLI binary. Renders only when:
 *
 *   - Status probe completes successfully
 *   - The binary is not on PATH
 *   - User has not previously dismissed the banner
 *
 * Dismissal is permanent (localStorage). The Settings → General → CLI
 * Binary panel always lets the user reinstall later.
 */
export function CliBinaryInstallBanner({ onOpenSettings }: Props) {
  const { t } = useTranslation("app");
  const [status, setStatus] = useState<FnBinaryStatus | null>(null);
  const [dismissed, setDismissed] = useState<boolean>(() => isDismissed());
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  useEffect(() => {
    if (dismissed) return;
    let cancelled = false;
    void fetchFnBinaryStatus()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => {
        // Treat probe failure as "don't show banner" — better silent than
        // bothering the user with infrastructure errors on first load.
      });
    return () => {
      cancelled = true;
    };
  }, [dismissed]);

  const handleInstall = useCallback(async () => {
    setInstalling(true);
    setInstallError(null);
    try {
      const response = await installFnBinary();
      setStatus({
        binary: response.binary,
        expectedVersion: response.expectedVersion,
        state: response.state,
        install: response.install,
      });
      if (!response.installResult.success) {
        setInstallError(
          response.installResult.permissionsHint ||
            response.installResult.stderr ||
            `Install failed (exit ${response.installResult.exitCode ?? "n/a"})`,
        );
      }
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  }, []);

  const handleDismiss = useCallback(() => {
    persistDismissal();
    setDismissed(true);
  }, []);

  if (dismissed) return null;
  if (!status) return null;
  if (status.state === "installed") return null;
  // Honour the global `fnBinaryCheckEnabled` opt-out — when checks are
  // disabled the install banner would be misleading.
  if (status.state === "skipped") return null;

  const isMismatch = status.state === "version-mismatch";
  const installedVersion = status.binary.version;
  const targetVersion = status.expectedVersion;
  const title = isMismatch ? t("cli.updateTitle", "Update the Fusion CLI") : t("cli.installTitle", "Install the Fusion CLI");
  const body = isMismatch ? (
    <>
      {t("cli.versionMismatchPrefix", "Your installed")} <code>fn</code>/<code>fusion</code> CLI is{" "}
      <strong>v{installedVersion ?? "unknown"}</strong> {t("cli.versionMismatchInfix", "but this dashboard expects")} {" "}
      <strong>v{targetVersion}</strong>. {t("cli.versionMismatchSuffix", "Update to stay in sync.")}
    </>
  ) : (
    <>
      {t("cli.installBody", "Get the {{fn}} and {{fusion}} commands on your terminal so you can drive Fusion from anywhere. One click below or copy the command into your shell.", { fn: "fn", fusion: "fusion" })}
    </>
  );
  const idleLabel = isMismatch ? t("cli.updateButton", "Update with npm") : t("cli.installButton", "Install with npm");
  const busyLabel = isMismatch ? t("cli.updating", "Updating…") : t("cli.installing", "Installing…");

  return (
    <div className="cli-binary-banner" role="status">
      <div className="cli-binary-banner__body">
        <div className="cli-binary-banner__title">{title}</div>
        <div className="cli-binary-banner__text">{body}</div>
        <div className="cli-binary-banner__actions">
          <button
            type="button"
            className="cli-binary-banner__primary"
            onClick={() => void handleInstall()}
            disabled={installing}
          >
            {installing ? busyLabel : idleLabel}
          </button>
          <button
            type="button"
            className="cli-binary-banner__secondary"
            onClick={onOpenSettings}
          >
            {t("cli.openSettings", "Open Settings")}
          </button>
        </div>
        {installError && (
          <div className="cli-binary-banner__error">{installError}</div>
        )}
      </div>
      <button
        type="button"
        className="cli-binary-banner__dismiss"
        aria-label={t("actions.dismiss", "Dismiss")}
        onClick={handleDismiss}
      >
        <X size={16} />
      </button>
    </div>
  );
}
