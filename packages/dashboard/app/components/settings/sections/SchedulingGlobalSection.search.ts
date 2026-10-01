/**
 * Search entries for the Scheduling · Global section.
 *
 * FNXC:VerificationResourceBound 2026-09-10-13:09:
 * RUFU-212. One entry per descriptor row the section renders; labels and help mirror the
 * section's `t()` calls verbatim so search matches the copy operators actually read. The
 * keywords carry the machine-wide framing ("every project", "whole machine") that separates
 * these fallbacks from their project-override twins in the "scheduling" index.
 */
import type { SettingsSearchEntry } from "../search/types";

export const schedulingGlobalSearchEntries: SettingsSearchEntry[] = [
  {
    sectionId: "scheduling-global",
    key: "verificationCpuQuotaPercent",
    labelKey: "settings.schedulingGlobal.verificationCpuQuotaPercent",
    labelFallback: "Global verification CPU quota (%)",
    helpKey: "settings.schedulingGlobal.verificationCpuQuotaPercentHelp",
    helpFallback: "Machine-wide CPUQuota per verification (200 = 2 cores) for projects that do not set their own. Empty = derived default: roughly half the machine's cores, at least 100%. 0 disables bounding machine-wide.",
    keywords: ["cpu", "throttle", "whole machine", "every project", "slow desktop", "crawl"],
  },
  {
    sectionId: "scheduling-global",
    key: "verificationCpuIoWeight",
    labelKey: "settings.schedulingGlobal.verificationCpuIoWeight",
    labelFallback: "Global verification CPU/IO weight",
    helpKey: "settings.schedulingGlobal.verificationCpuIoWeightHelp",
    helpFallback: "Machine-wide CPU/IO weight while unthrottled (1–10000; lower keeps the desktop responsive). Empty = default 10. 0 disables weight shaping machine-wide.",
    keywords: ["nice", "priority", "io", "disk", "machine-wide", "responsiveness"],
  },
  {
    sectionId: "scheduling-global",
    key: "verificationMemoryMaxMb",
    labelKey: "settings.schedulingGlobal.verificationMemoryMaxMb",
    labelFallback: "Global verification memory cap (MB)",
    helpKey: "settings.schedulingGlobal.verificationMemoryMaxMbHelp",
    helpFallback: "Machine-wide MemoryMax per verification, in MB. Empty = no memory cap. 0 disables the cap machine-wide.",
    keywords: ["memory", "ram", "oom", "machine-wide", "every project"],
  },
];
