/*
FNXC:StashRecovery 2026-06-24-00:00:
App-level count of orphaned stash-recovery entries, polled every 30s and surfaced as a header/mobile-nav badge. Extracted verbatim from AppInner so the root component no longer owns the polling loop.
*/

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { deferToIdle } from "../utils/defer-to-idle";
import { useVisibilityAwarePoll } from "./visibilitySuspension";

export interface UseStashOrphanCountResult {
  stashOrphanCount: number;
}

const POLL_INTERVAL_MS = 30000;

export function useStashOrphanCount(currentProjectId: string | undefined): UseStashOrphanCountResult {
  const [stashOrphanCount, setStashOrphanCount] = useState(0);

  const contextVersionRef = useRef(0);

  const load = useCallback(async () => {
    const versionAtStart = contextVersionRef.current;
    try {
      const data = await api<{ count: number }>("/stash-recovery/orphans");
      if (contextVersionRef.current === versionAtStart) setStashOrphanCount(data.count ?? 0);
    } catch {
      if (contextVersionRef.current === versionAtStart) setStashOrphanCount(0);
    }
  }, [currentProjectId]);

  /*
  FNXC:IdleBoardReadCost 2026-11-18-09:28 (RUFU-479): the first badge read no longer competes with the board.
  This read used to fire synchronously on mount, i.e. inside the boot burst where 42 of 63 requests landed in
  one second against a queue that serves four at a time. Its value is a header badge that reads zero on almost
  every board, so it was spending a read slot that a lane read needed - and on the deployed node a single
  route can hold a slot for seconds.

  The read is DEFERRED, not dropped: the badge still counts without any user action, a couple of frames later,
  and the 30 s visibility-aware poll below is unchanged. A badge that silently never arrived would be a wrong
  badge; this only moves the request out of the window the board is fighting for.
  */
  useEffect(() => {
    const cancel = deferToIdle(() => {
      /*
      FNXC:MobileTabRetention 2026-11-18-11:40 (RUFU-479): the deferral inherits the suspension rule instead of
      smuggling past it. This hook already refuses to poll while the document is hidden - a badge count nobody
      can see is a background-network discard signal, which is what produced the mobile white-splash reload -
      and a mount that happens in a backgrounded tab would otherwise have issued its one read through the
      idle timer and broken that guarantee by the back door. The predicate is `visibilityState`, the same one
      `useVisibilityAwarePoll` itself tests, not `document.hidden`: a deferred read that consulted a different
      flag than the poll it is subordinate to would be suspended by one rule and released by another. And
      `useVisibilityAwarePoll` re-runs `load` when the tab is shown, so skipping here defers the badge, it
      does not lose it.
      */
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void load();
    });
    return () => {
      cancel();
      contextVersionRef.current += 1;
    };
  }, [load]);

  /*
  FNXC:MobileTabRetention 2026-07-26-10:50:
  The 30s stash-orphan badge poll is suspended while the document is hidden. A badge count nobody can see is
  never worth keeping a backgrounded mobile tab awake — background network work is a primary OS discard
  signal and produced the white-splash reload on return. The badge re-counts once when the tab is shown again.
  */
  useVisibilityAwarePoll(load, POLL_INTERVAL_MS);

  return { stashOrphanCount };
}
