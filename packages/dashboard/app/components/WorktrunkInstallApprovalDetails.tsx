import "./WorktrunkInstallApprovalDetails.css";
import type { ApprovalRequestDetail } from "../api";

interface WorktrunkInstallApprovalDetailsProps {
  targetAction: ApprovalRequestDetail["targetAction"];
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readAsset(context: Record<string, unknown> | undefined): { url: string | null; sha256: string | null } {
  if (!context) return { url: null, sha256: null };
  const assets = context.assets;
  if (!assets || typeof assets !== "object") return { url: null, sha256: null };
  const firstAsset = Object.values(assets as Record<string, unknown>)[0];
  if (!firstAsset || typeof firstAsset !== "object") return { url: null, sha256: null };
  const asset = firstAsset as Record<string, unknown>;
  return {
    url: readString(asset.url),
    sha256: readString(asset.sha256),
  };
}

export function WorktrunkInstallApprovalDetails({ targetAction }: WorktrunkInstallApprovalDetailsProps) {
  const context = targetAction.context as Record<string, unknown> | undefined;
  const version = readString(context?.version);
  const installPath = readString(context?.installPath) ?? targetAction.resourceId;
  const { url, sha256 } = readAsset(context);

  return (
    <section className="card worktrunk-install-approval-details" data-testid="worktrunk-install-approval-details">
      <h4 className="worktrunk-install-approval-details__title">Worktrunk install request</h4>
      <dl className="worktrunk-install-approval-details__list">
        <div className="worktrunk-install-approval-details__row">
          <dt>Version</dt>
          <dd>{version ?? "Unknown"}</dd>
        </div>
        <div className="worktrunk-install-approval-details__row">
          <dt>Asset URL</dt>
          <dd>{url ?? "Unknown"}</dd>
        </div>
        <div className="worktrunk-install-approval-details__row">
          <dt>SHA-256</dt>
          <dd>{sha256 ?? "Unknown"}</dd>
        </div>
        <div className="worktrunk-install-approval-details__row">
          <dt>Install path</dt>
          <dd>{installPath ?? "Unknown"}</dd>
        </div>
      </dl>
    </section>
  );
}
