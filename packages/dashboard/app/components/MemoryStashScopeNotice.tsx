import { useTranslation } from "react-i18next";
// Direct module import, not the `../api` compatibility barrel: `api/legacy.ts` re-exports an explicit
// named list from `system/memory`, so a helper added there is NOT reachable through the barrel until
// it is listed. Same pattern `TerminalLauncher.tsx` uses for `api/system/workflows`.
import { stashScopeDroppedCount, type StashReadScope } from "../api/system/memory.js";

/**
 * One sentence: this project's Stash read was answered, and some of those rows belonged to someone
 * else. Renders nothing when there is nothing to report.
 *
 * FNXC:StashReadScope 2026-11-19-13:41 (RUFU-1008):
 * WHY A SHARED COMPONENT. Two surfaces show a memory retrieval result — Settings > Memory and the
 * Memory view — and both must tell this truth identically. Written twice it would drift (and one
 * copy silently missing is exactly how a drop became invisible in the first place), so the wording
 * lives here and both surfaces mount this. It is a module-scope component, not one declared inside
 * another: a nested definition remounts the subtree on every parent render.
 *
 * WHAT IT MUST NEVER DO: quote a dropped line, name the other project, or show the Stash URL. The
 * counts are the whole payload — the operator needs to know the answer was filtered, not to read
 * another project's memory.
 */
export function MemoryStashScopeNotice({ scope }: { scope?: StashReadScope | null }) {
  const { t } = useTranslation("app");
  if (stashScopeDroppedCount(scope) <= 0 || !scope) return null;
  return (
    <small>
      {t("memory.stashScopeDropped", "Excluded {{foreign}} line(s) from other Fusion projects and {{unidentified}} line(s) with no project identity.", {
        foreign: scope.droppedForeignCount,
        unidentified: scope.droppedUnidentifiedCount,
      })}
    </small>
  );
}
