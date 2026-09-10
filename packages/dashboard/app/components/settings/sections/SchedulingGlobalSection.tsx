import type { GlobalSettings } from "@fusion/core";
import { useTranslation } from "react-i18next";
import { SettingsNumberRow } from "../SettingsNumberRow";
import type { SectionBaseProps } from "./context";

/**
 * The machine-wide verification resource-bound fallbacks (RUFU-212).
 * Exported so SettingsModal's scoped state shares ONE type with this section.
 */
export type GlobalVerificationBoundSettings = Pick<
  GlobalSettings,
  "verificationCpuQuotaPercent" | "verificationCpuIoWeight" | "verificationMemoryMaxMb"
>;

export interface SchedulingGlobalSectionProps extends SectionBaseProps {
  globalSettings: GlobalVerificationBoundSettings | null;
  onGlobalVerificationBoundSettingsChange: (patch: Partial<GlobalVerificationBoundSettings>) => void;
}

/*
FNXC:VerificationResourceBound 2026-09-10-13:09:
RUFU-212 pairs this section with the project "Scheduling" section, exactly like
`source-control-global` pairs with `source-control`: the three verification resource-bound keys
(CPUQuota %, CPU/IO weight, MemoryMax MB) are dual scope — a machine-wide fallback here, a
per-project override there. `splitSettingsSave` gates these keys on the ACTIVE SECTION ID: they
route to the global patch only while this section is open. Renaming this section id without
updating save-split.ts would silently write the global fallbacks into project settings.

FNXC:SettingsScope 2026-09-10-13:09:
No scope badge on any row here: all three keys are declared in BOTH `DEFAULT_GLOBAL_SETTINGS`
and `DEFAULT_PROJECT_SETTINGS`, so no badge can state their scope honestly (same doctrine as
SourceControlGlobalSection). The section name ("Scheduling · Global") and each label's
"Global …" prefix carry it.

FNXC:GitLabEnablement 2026-09-10-13:09 (pattern reuse):
Rows read from the SCOPED global values (`globalSettings`), not the merged `form`, so a project
override never renders as the global fallback's value; `form` is only the fallback while the
scoped fetch is in flight. The unset copy states the RUNTIME-derived default (≈half the machine's
cores, floor 100%) rather than a number this file cannot compute.
*/
export function SchedulingGlobalSection({ form, globalSettings, onGlobalVerificationBoundSettingsChange }: SchedulingGlobalSectionProps) {
  const { t } = useTranslation("app");
  const globalValues = globalSettings ?? form;
  return (<>
    <h4 className="settings-section-heading">{t("settings.schedulingGlobal.schedulingGlobal", "Scheduling · Global")}</h4>
    <SettingsNumberRow
      descriptor={{
        key: "verificationCpuQuotaPercent",
        label: t("settings.schedulingGlobal.verificationCpuQuotaPercent", "Global verification CPU quota (%)"),
        help: t("settings.schedulingGlobal.verificationCpuQuotaPercentHelp", "Machine-wide CPUQuota per verification (200 = 2 cores) for projects that do not set their own. Empty = derived default: roughly half the machine's cores, at least 100%. 0 disables bounding machine-wide."),
      }}
      value={globalValues.verificationCpuQuotaPercent ?? null}
      onChange={(v) => onGlobalVerificationBoundSettingsChange({ verificationCpuQuotaPercent: v === null ? undefined : Math.max(0, Math.floor(v)) })}
    />
    <SettingsNumberRow
      descriptor={{
        key: "verificationCpuIoWeight",
        label: t("settings.schedulingGlobal.verificationCpuIoWeight", "Global verification CPU/IO weight"),
        help: t("settings.schedulingGlobal.verificationCpuIoWeightHelp", "Machine-wide CPU/IO weight while unthrottled (1–10000; lower keeps the desktop responsive). Empty = default 10. 0 disables weight shaping machine-wide."),
      }}
      value={globalValues.verificationCpuIoWeight ?? null}
      onChange={(v) => onGlobalVerificationBoundSettingsChange({ verificationCpuIoWeight: v === null ? undefined : Math.max(0, Math.floor(v)) })}
    />
    <SettingsNumberRow
      descriptor={{
        key: "verificationMemoryMaxMb",
        label: t("settings.schedulingGlobal.verificationMemoryMaxMb", "Global verification memory cap (MB)"),
        help: t("settings.schedulingGlobal.verificationMemoryMaxMbHelp", "Machine-wide MemoryMax per verification, in MB. Empty = no memory cap. 0 disables the cap machine-wide."),
      }}
      value={globalValues.verificationMemoryMaxMb ?? null}
      onChange={(v) => onGlobalVerificationBoundSettingsChange({ verificationMemoryMaxMb: v === null ? undefined : Math.max(0, Math.floor(v)) })}
    />
  </>);
}
