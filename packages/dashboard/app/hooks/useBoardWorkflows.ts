import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  fetchBoardWorkflows as defaultFetchBoardWorkflows,
  type BoardWorkflowDefinition,
  type BoardWorkflowsPayload,
} from "../api";
import { setProjectBoardSelectedWorkflow as defaultPersistBoardWorkflowSelection } from "../api/system/workflows";
import { subscribeSse as defaultSubscribeSse } from "../sse-bus";
import {
  clearBoardWorkflowsCache as defaultClearBoardWorkflowsCache,
  readBoardWorkflowsCache as defaultReadBoardWorkflowsCache,
  writeBoardWorkflowsCache as defaultWriteBoardWorkflowsCache,
} from "../utils/boardWorkflowsCache";
import {
  ALL_WORKFLOWS_BOARD_VIEW_ID,
  readBoardWorkflowViewSelection,
  removeBoardWorkflowSelection,
  writeBoardWorkflowSelection,
} from "../utils/boardWorkflowSelection";
import { notifyWorkflowSettingValuesUpdatedFromSse } from "../utils/workflowSettingValuesEvents";
import {
  notifyBoardWorkflowSelectionChanged,
  subscribeBoardWorkflowSelection,
  type BoardWorkflowSelectionValue,
} from "../utils/boardWorkflowSelectionEvents";

/*
FNXC:Workflows 2026-06-22-17:00:
Single source of truth for board-workflow fetch/cache/SSE/selection, shared verbatim by Board.tsx and the Planning header slot (PlanningWorkflowSwitcherSlot.tsx). Both surfaces must show the SAME workflow dropdown driven by the SAME data path: refetch on mount, on tab visibility/focus, and on `workflow:created|updated|deleted` SSE; every fetch is guarded by a monotonic sequence ref that drops out-of-order responses; successful payloads persist to the per-project session cache. Selection (`selectedWorkflowId`) hydrates from project-scoped durable storage, user changes write immediately, and stale stored ids are repaired only after the current payload proves the workflow no longer exists.

FNXC:Workflows 2026-06-29-14:45:
Transient board-workflows fetch failures are not authoritative workflow-mode disable signals. Preserve the last payload and durable workflow selection on API/focus/refresh blips so operators return to their selected lane unless the server explicitly returns workflow mode off, an empty list, or a single unswitchable workflow.

Per-consumer subscription semantics are preserved: each call to this hook installs its OWN visibilitychange/focus listeners and its OWN SSE subscription, so two consumers (Board + Planning slot) each subscribe and unsubscribe independently — the hook does not dedupe across consumers. Dependencies (fetch, subscribeSse, cache helpers) are injectable to keep the hook DI-friendly and free of App-level singletons.

FNXC:BoardWorkflowSelection 2026-09-16-23:24:
FN-483 — LE CHOIX DE L'OPÉRATEUR EST PARTAGÉ, LES DONNÉES RESTENT LOCALES. Depuis qu'un seul sélecteur contextuel
existe par en-tête (le Board de fond sur téléphone), les autres consommateurs montés du MÊME projet doivent suivre ce
choix : une List déjà visitée restait sinon sur l'ancienne lane, puisque la préférence durable n'est relue qu'au
montage ou au changement de projet. Le setter piloté par l'opérateur publie donc la valeur brute via
`boardWorkflowSelectionEvents` APRÈS commit, jamais depuis un updater React ; les récepteurs appliquent l'état sans
réémettre, sans réécrire le stockage et sans rappeler le miroir serveur, de sorte qu'un choix produit AU PLUS UN
miroir. Les fetch, l'abonnement SSE, le fencing par séquence et le payload restent strictement par instance ; aucun
cache global n'est introduit. L'ancien contrat d'isolation par instance ne vaut plus que D'UN PROJET À L'AUTRE.
*/

export interface UseBoardWorkflowsParams {
  projectId?: string;
  fetchBoardWorkflows?: typeof defaultFetchBoardWorkflows;
  subscribeSse?: typeof defaultSubscribeSse;
  readBoardWorkflowsCache?: typeof defaultReadBoardWorkflowsCache;
  writeBoardWorkflowsCache?: typeof defaultWriteBoardWorkflowsCache;
  clearBoardWorkflowsCache?: typeof defaultClearBoardWorkflowsCache;
  /**
   * FNXC:OriginWorkflowSelection 2026-07-26-19:40:
   * Server-side mirror of the operator's lane, so `fn task create` / `fn_task_create` /
   * refinement can resolve the "Selected workflow" option of `taskCreateWorkflowId` /
   * `refinementTaskWorkflowId`. Injectable like the other deps to keep the hook testable.
   */
  persistBoardWorkflowSelection?: typeof defaultPersistBoardWorkflowSelection;
  /*
  FNXC:BoardBootRequestSet 2026-11-08-03:34 (RUFU-493):
  Which cards THIS consumer renders. Every board-workflows read a consumer with ids issues after its
  first answer is then bounded to `?taskIds=…&partial=1` — the named-id route answers from the ids alone
  and spends zero whole-table reads, while the unbounded enumeration materialises the whole current-task
  table plus the newest Done page (measured 30.0 s then 17.4 s on the deployed node for one mount).
  Passing ids is what makes a mid-session refresh (tab focus, visibility, SSE reconnect) cheap; the
  unbounded read stays for the one request that must first learn which lanes exist at all.
  */
  taskIds?: readonly string[];
  /**
   * A vocabulary-only consumer (the header workflow switcher): it renders the lane list and never reads
   * `taskWorkflowIds`, so `"lanes"` asks the server for exactly that — the one catalog read plus lane
   * descriptions, with no task-table and no Done-page read behind it.
   */
  scope?: "lanes";
}

/**
 * Options one board-workflows read may carry. Declared once so the hook's internal default scope and the
 * public `refreshBoardWorkflows` signature cannot drift apart — the default IS one of these shapes.
 *
 * FNXC:BoardBootRequestSet 2026-11-08-05:09 (RUFU-493).
 */
export interface BoardWorkflowsRefreshOptions {
  forceFresh?: boolean;
  taskIds?: readonly string[];
  partial?: boolean;
  /** Vocabulary-only read: lane definitions and default, no per-task mapping. */
  scope?: "lanes";
}

export interface UseBoardWorkflowsResult {
  /** Raw payload for the current project, or null when unloaded / project mismatch. */
  boardWorkflows: BoardWorkflowsPayload | null;
  /** True when the flag is on AND at least one workflow is defined. */
  workflowMode: boolean;
  /** Workflows sorted with the default first, then alphabetical. Empty unless in workflow mode. */
  workflowOptions: BoardWorkflowDefinition[];
  /** Currently selected real workflow (resolved from selection / default / first), or null. */
  selectedWorkflow: BoardWorkflowDefinition | null;
  selectedWorkflowId: string | null;
  /** True when the dashboard-only aggregate workflow view is selected. */
  isAllWorkflowsSelected: boolean;
  setSelectedWorkflowId: Dispatch<SetStateAction<string | null>>;
  /** Force a fresh fetch (used on switcher open, and when the board detects a rendered
   *  task missing from `taskWorkflowIds`, since task→workflow assignment emits no workflow SSE).
   *  Resolves when the fetch has SETTLED — it never rejects, since a failed fetch is
   *  non-authoritative — so a caller that must not overlap attempts can await it. */
  refreshBoardWorkflows: (options?: BoardWorkflowsRefreshOptions) => Promise<void>;
  /**
   * Raw state setter, exposed so Board can apply optimistic task→workflow assignment.
   * Planning does not use this.
   */
  setBoardWorkflowsState: Dispatch<SetStateAction<{ projectId?: string; payload: BoardWorkflowsPayload } | null>>;
}

/*
FNXC:BoardWorkflows 2026-10-01-21:51:
A `?taskIds=…&partial=1` response answers ONLY the ids it was asked about, so its `workflows` array is the
subset those ids reference — not the lane set the board is showing. Applying it like a normal response
would delete lanes that still hold cards, which is exactly the failure that kept the named-id repair path
asking for everything (and paying a whole-table scan for it: 14.2 s measured to answer 241 cards when ONE
was requested).

Merging is therefore the contract that makes a bounded request legal: lanes only ever grow, a card's
mapping is only ever refreshed, and the answer to "which lanes exist?" stays with the last UNBOUNDED
response. Existing lane order is preserved and new workflows append, so a partial answer can never
reorder the board the operator is looking at.
*/
export function mergePartialBoardWorkflows(
  current: BoardWorkflowsPayload,
  partial: BoardWorkflowsPayload,
): BoardWorkflowsPayload {
  // A flag-off answer is authoritative about workflow mode being off; a flag-off current is not worth keeping.
  if (!partial.flagEnabled || !current.flagEnabled) return partial;
  const byId = new Map(current.workflows.map((workflow) => [workflow.id, workflow]));
  for (const workflow of partial.workflows) byId.set(workflow.id, workflow);
  /*
  FNXC:BoardBootRequestSet 2026-11-08-05:07 (RUFU-493):
  A bounded (`?taskIds=…&partial=1`) answer is a PATCH and this merge stays a pure union, including for
  the ids the request itself named. Dropping named-but-unanswered ids looks stricter and is wrong twice
  over: the server answers a card only when it holds a selection ROW, so an omitted card is one that
  inherits the default workflow and has nothing to keep; and a payload answering a subset of the board's
  cards would strip the mapping of every card the caller did not name — the same shrinkage that kept the
  named-id path asking for everything (14.2 s measured to answer 241 cards when ONE was asked). The one
  mutation that bulk-removes selections is deleting a workflow, and that emits `workflow:deleted`, whose
  refresh is unbounded and REPLACES the payload — so no stale mapping survives it.
  */
  return {
    flagEnabled: true,
    defaultWorkflowId: partial.defaultWorkflowId || current.defaultWorkflowId,
    workflows: [...byId.values()],
    taskWorkflowIds: { ...current.taskWorkflowIds, ...partial.taskWorkflowIds },
  };
}

export function useBoardWorkflows(params: UseBoardWorkflowsParams): UseBoardWorkflowsResult {
  const {
    projectId,
    fetchBoardWorkflows = defaultFetchBoardWorkflows,
    subscribeSse = defaultSubscribeSse,
    readBoardWorkflowsCache = defaultReadBoardWorkflowsCache,
    writeBoardWorkflowsCache = defaultWriteBoardWorkflowsCache,
    clearBoardWorkflowsCache = defaultClearBoardWorkflowsCache,
    persistBoardWorkflowSelection = defaultPersistBoardWorkflowSelection,
    taskIds,
    scope,
  } = params;

  const [boardWorkflowsState, setBoardWorkflowsState] = useState<{ projectId?: string; payload: BoardWorkflowsPayload } | null>(() => {
    const cached = readBoardWorkflowsCache(projectId);
    return cached ? { projectId, payload: cached } : null;
  });
  const boardWorkflows = boardWorkflowsState?.projectId === projectId && boardWorkflowsState ? boardWorkflowsState.payload : null;
  const [selectedWorkflowId, setSelectedWorkflowIdState] = useState<string | null>(() => readBoardWorkflowViewSelection(projectId));
  const storedSelectionRef = useRef<string | null>(selectedWorkflowId);
  /** Lane mirror queued by the user-driven setter; `undefined` = nothing to flush. */
  const pendingLaneMirrorRef = useRef<string | null | undefined>(undefined);
  /*
  FNXC:BoardWorkflowSelection 2026-09-16-23:24:
  FN-483 : publication inter-consommateurs mise en file par le setter opérateur. Le PROJET D'ORIGINE est mémorisé
  avec la valeur brute, afin qu'un changement de projet survenu entre le choix et le commit ne diffuse jamais la
  sélection dans le projet suivant. `undefined` = rien en attente.
  */
  const pendingSelectionBroadcastRef = useRef<{ projectId?: string; selection: BoardWorkflowSelectionValue } | undefined>(undefined);

  const setSelectedWorkflowId = useCallback<Dispatch<SetStateAction<string | null>>>((nextSelection) => {
    setSelectedWorkflowIdState((previousSelection) => {
      const resolvedSelection = typeof nextSelection === "function"
        ? nextSelection(previousSelection)
        : nextSelection;
      storedSelectionRef.current = resolvedSelection;
      if (resolvedSelection) {
        writeBoardWorkflowSelection(projectId, resolvedSelection);
      } else {
        removeBoardWorkflowSelection(projectId);
      }
      /*
      FNXC:OriginWorkflowSelection 2026-07-26-19:40:
      Queue the server-side lane mirror only on this USER-driven setter, not on the
      stale-selection repair effect below — the mirror should track what the operator chose,
      not the hook's own bookkeeping. The all-workflows sentinel is a Board-only view, never
      a real workflow id, so it queues a CLEAR rather than being persisted as an id.
      Queued, not issued here: React may invoke a state updater more than once for a single
      change, and firing a request from inside one produced duplicate writes and a render
      loop. The flush effect below owns the actual call.
      */
      pendingLaneMirrorRef.current = resolvedSelection && resolvedSelection !== ALL_WORKFLOWS_BOARD_VIEW_ID
        ? resolvedSelection
        : null;
      /*
      FNXC:BoardWorkflowSelection 2026-09-16-23:24:
      FN-483 : même discipline que le miroir — mise en file ici, émission après commit. Émettre depuis cet updater
      ferait réagir d'autres composants pendant un rendu, et React peut invoquer un updater plus d'une fois. La valeur
      diffusée est la valeur BRUTE, sentinel agrégé inclus : c'est une vue partagée, pas un identifiant serveur.
      */
      pendingSelectionBroadcastRef.current = { projectId, selection: resolvedSelection };
      return resolvedSelection;
    });
  }, [projectId]);

  /*
  FNXC:OriginWorkflowSelection 2026-07-26-19:40:
  Flush the queued lane mirror after commit. `undefined` means "nothing queued" — distinct
  from `null`, which is a real instruction to CLEAR the mirror — so the effect is a no-op on
  mount and on every render the operator did not drive. Unkeyed on purpose: it must run after
  whichever commit the setter's update landed in, and the ref latch already bounds it to one
  request per operator action.
  The promise is unawaited and its rejection swallowed: localStorage already holds the
  authoritative selection, so a failed mirror must never revert or block the lane switch.
  */
  useEffect(() => {
    const pending = pendingLaneMirrorRef.current;
    if (pending === undefined) return;
    pendingLaneMirrorRef.current = undefined;
    void persistBoardWorkflowSelection(pending, projectId).catch(() => {});
  });

  /*
  FNXC:BoardWorkflowSelection 2026-09-16-23:24:
  FN-483 : diffusion du choix opérateur aux autres consommateurs montés du même projet, après commit. La demande est
  VIDÉE AVANT l'émission pour résister à la réentrance et à StrictMode : un récepteur ne peut donc pas provoquer une
  seconde publication du même choix. Seul ce chemin publie ; ni le montage, ni l'ouverture d'un drawer, ni la
  réparation d'une sélection périmée ne se transforment en choix utilisateur.
  */
  useEffect(() => {
    const pending = pendingSelectionBroadcastRef.current;
    if (pending === undefined) return;
    pendingSelectionBroadcastRef.current = undefined;
    notifyBoardWorkflowSelectionChanged(pending.projectId, pending.selection);
  });

  /*
  FNXC:BoardWorkflowSelection 2026-09-16-23:24:
  FN-483 : réception. On n'applique QUE l'état local — l'émetteur a déjà écrit la préférence durable et poussé le
  miroir serveur, donc réécrire ici multiplierait les requêtes par abonné. `storedSelectionRef` suit la valeur pour
  que la réparation d'une sélection périmée garde son comportement. L'abonnement est scopé par projet et retiré au
  changement de projet comme au démontage.
  */
  useEffect(() => {
    return subscribeBoardWorkflowSelection(projectId, (selection) => {
      storedSelectionRef.current = selection;
      setSelectedWorkflowIdState(selection);
    });
  }, [projectId]);

  // Stale-response guard: a monotonic sequence ref drops out-of-order responses.
  const boardWorkflowsFetchSeqRef = useRef(0);

  // Re-hydrate from the per-project cache on project change.
  useEffect(() => {
    const cached = readBoardWorkflowsCache(projectId);
    const storedSelection = readBoardWorkflowViewSelection(projectId);
    storedSelectionRef.current = storedSelection;
    setSelectedWorkflowIdState(storedSelection);
    setBoardWorkflowsState(cached ? { projectId, payload: cached } : null);
  }, [projectId, readBoardWorkflowsCache]);

  /*
  FNXC:BoardWorkflows 2026-10-01-21:51:
  Read the held payload through a ref rather than the callback's dependency list: `refreshBoardWorkflows`
  is a dependency of the SSE/focus resync effect, so making it change whenever the payload changes would
  resubscribe the board's event stream on every metadata answer.
  */
  const boardWorkflowsHeldRef = useRef<{ projectId?: string; payload: BoardWorkflowsPayload } | null>(null);
  useEffect(() => {
    boardWorkflowsHeldRef.current = boardWorkflowsState;
  }, [boardWorkflowsState]);

  /*
  FNXC:WorkflowBoard 2026-07-29-00:00 (PR #2530 review — greptile):
  RETURNS its settle promise now (additive — existing callers ignore it). The
  unmapped-workflow repair needs to know when a forced refresh has SETTLED: on a slow
  request it was starting its second attempt on a fixed 250ms timer while the first was
  still in flight, so both attempts could be spent before either answer arrived. The
  promise never rejects — a failed fetch stays non-authoritative — so awaiting it is
  safe for every caller.
  */
  /*
  FNXC:BoardBootRequestSet 2026-11-08-03:34 (RUFU-493):
  Ids and scope are read through refs, not captured in the callback's deps: `refreshBoardWorkflows` is a
  dependency of the SSE/visibility effect below, and a task-id array is a fresh object on every render —
  capturing it would re-subscribe the event stream on every board paint.
  */
  const taskIdsRef = useRef<readonly string[]>(taskIds ?? []);
  const scopeRef = useRef(scope);
  useEffect(() => {
    taskIdsRef.current = taskIds ?? [];
    scopeRef.current = scope;
  }, [taskIds, scope]);

  /*
  FNXC:BoardBootRequestSet 2026-11-08-05:10 (RUFU-493):
  Two different questions, two different scopes — and the difference is not an optimisation, it is what a
  response is ALLOWED to say.

  A MOUNT asks "which lanes exist, and what does the board map?". Only the whole-board answer can express
  that vocabulary, because a patch cannot: an answer that names no lane does not mean the lane set shrank,
  and a patch merged over a held payload keeps a lane or a default workflow the server has just stopped
  reporting. Measured against the App composition suite, scoping a mount to ids did exactly that — the
  switcher kept announcing a workflow the current payload no longer contained. So a mount stays whole-board
  for anyone who reads the mapping, and `scope=lanes` serves the consumer that reads only the vocabulary.

  A REFRESH caused by the tab coming back asks a narrower question: "do the cards I am showing still map to
  the same lanes?" Nothing about the vocabulary changed in the background — a lane that appeared, changed, or
  disappeared arrives on the `workflow:*` stream, whose refresh remains unbounded. So a focus/visibility
  refresh names its own ids and takes the patch, which is the read a laptop pays dozens of times a day.
  */
  const mountRefreshScope = useCallback((): BoardWorkflowsRefreshOptions | undefined => {
    return scopeRef.current === "lanes" ? { scope: "lanes" } : undefined;
  }, []);

  const mappingRefreshScope = useCallback((): BoardWorkflowsRefreshOptions | undefined => {
    if (scopeRef.current === "lanes") return { scope: "lanes" };
    const ids = taskIdsRef.current;
    if (ids.length > 0 && boardWorkflowsHeldRef.current?.projectId === projectId) {
      return { taskIds: ids, partial: true };
    }
    return undefined;
  }, [projectId]);

  const refreshBoardWorkflows = useCallback((options?: BoardWorkflowsRefreshOptions): Promise<void> => {
    const seq = ++boardWorkflowsFetchSeqRef.current;
    const effective = options ?? mountRefreshScope();
    const isPatch = Boolean(effective?.partial) || effective?.scope === "lanes";
    /*
    FNXC:BoardWorkflows 2026-10-01-21:51:
    A partial answer MERGES into the held payload, so clearing the cache first would throw away precisely
    the lane set the merge exists to preserve. Unbounded refreshes keep clearing (they answer the whole
    board and must not inherit a stale mapping for a card that moved workflow).
    */
    if (effective?.forceFresh && !effective?.partial) {
      clearBoardWorkflowsCache(projectId);
    }
    /*
    FNXC:BoardBootRequestSet 2026-11-08-05:08 (RUFU-493):
    An unscoped read is issued with the arity it had before this change — one argument, no options object —
    so a consumer that must enumerate stays literally the same request it always was.
    */
    const fetchPromise = effective === undefined
      ? fetchBoardWorkflows(projectId)
      : fetchBoardWorkflows(projectId, effective);
    return fetchPromise
      .then((payload) => {
        if (seq !== boardWorkflowsFetchSeqRef.current) return;
        const held = boardWorkflowsHeldRef.current;
        /*
        FNXC:BoardBootRequestSet 2026-11-08-04:05 (RUFU-493):
        The ids this request named are authoritative for THIS answer: a card whose selection was reset to
        the default answers with no row for itself, and a plain union would keep showing the lane it left
        until some later unbounded refresh. Names are only ever a subset of what the caller renders, so
        dropping the omitted ones cannot hide a lane — the lane set still only grows.
        */
        const heldSameProject = Boolean(held && held.projectId === projectId);
        const next = isPatch && heldSameProject && held
          ? mergePartialBoardWorkflows(held.payload, payload)
          : payload;
        boardWorkflowsHeldRef.current = { projectId, payload: next };
        setBoardWorkflowsState({ projectId, payload: next });
        /*
        FNXC:BoardBootRequestSet 2026-11-08-05:42 (RUFU-493 code review, P2):
        A patch merged over NOTHING is not a mapping, and the per-project cache is the one place the card-to-
        lane mapping lives. A `scope:"lanes"` answer carries `taskWorkflowIds: {}` by contract - it was asked
        about lanes, not cards - so publishing it as though it were complete emptied the shared mapping for
        every other consumer of that project. The switcher's lanes read and the board's mount read race, and
        when the lanes answer landed LAST the session cache was left with an empty mapping, so the next
        hydrating mount painted every card on the default lane until its own unbounded read answered
        (measured 17-30 s). A patch may only be published over the payload it was merged with; a consumer
        that holds nothing keeps its answer in its own state, where a vocabulary cannot masquerade as a map.
        */
        if (!isPatch || heldSameProject) {
          writeBoardWorkflowsCache(projectId, next);
        }
      })
      .catch(() => {
        // Fetch failures are non-authoritative: keep the current/cache-hydrated payload so the cleanup effect does not erase durable selection.
      });
  }, [projectId, mountRefreshScope, fetchBoardWorkflows, writeBoardWorkflowsCache, clearBoardWorkflowsCache]);

  useEffect(() => {
    refreshBoardWorkflows();
    const onVisible = () => {
      /*
      FNXC:BoardBootRequestSet 2026-11-08-05:10 (RUFU-493): the tab returning is a MAPPING refresh, so it
      names this consumer's cards when it has them; `{}` keeps the whole-board answer for a consumer that
      has no ids to name.
      */
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        refreshBoardWorkflows(mappingRefreshScope() ?? {});
      }
    };
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
    if (typeof window !== "undefined") window.addEventListener("focus", onVisible);
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    /*
    FNXC:BoardBootRequestSet 2026-11-08-03:34 (RUFU-493):
    A workflow mutation must still be answered FRESH, but "fresh" is about not reusing a cached answer —
    it never meant "enumerate every task again". The force is combined with this consumer's scope so a
    switcher keeps asking for lanes and a board keeps asking for its own cards.
    */
    const forceRefreshBoardWorkflows = () => refreshBoardWorkflows({ forceFresh: true });
    /*
    FNXC:BoardWorkflows 2026-07-26-15:14:
    The visibilitychange/focus listeners above cover a backgrounded tab, but not an error-driven SSE
    reconnect while the tab stays visible, during which workflow mutations are dropped. Declare the
    resync on the subscription itself so recovery does not depend on which of the two paths fired.
    */
    const unsubscribe = subscribeSse(`/api/events${query}`, {
      onReconnect: forceRefreshBoardWorkflows,
      events: {
        "workflow:created": forceRefreshBoardWorkflows,
        "workflow:updated": forceRefreshBoardWorkflows,
        "workflow:deleted": forceRefreshBoardWorkflows,
        "workflow:setting-values-updated": (event: MessageEvent) => {
          try {
            notifyWorkflowSettingValuesUpdatedFromSse(JSON.parse(event.data) as Record<string, unknown>);
          } catch {
            // Malformed SSE payloads are non-authoritative and cannot invalidate a card.
          }
        },
      },
    });
    return () => {
      // Advance the seq so any in-flight response is dropped on cleanup.
      boardWorkflowsFetchSeqRef.current++;
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
      if (typeof window !== "undefined") window.removeEventListener("focus", onVisible);
      unsubscribe();
    };
  }, [projectId, refreshBoardWorkflows, mappingRefreshScope, subscribeSse]);

  /*
  FNXC:WorkflowColumns 2026-07-28-00:00 (U12 — R9):
  Workflow mode is now "this project resolved at least one lane", nothing else.
  The former `flagEnabled === true` conjunct is DELETED: the server hardcodes that
  field to `true` (`buildBoardWorkflowsPayload`), so it could only ever narrow the
  result to itself. Reading it kept a retired kill switch alive on the client, one
  stale payload away from silently reverting every consumer to the legacy board.
  */
  const workflowMode = Boolean(boardWorkflows?.workflows.length);

  const workflowOptions = useMemo<BoardWorkflowDefinition[]>(() => {
    if (!workflowMode || !boardWorkflows) return [];
    /*
    FNXC:DisabledBuiltinWorkflows 2026-08-19-00:18:
    The payload retains disabled definitions only for cards with explicit legacy
    assignments. Switcher options must use the server's selectable marker so
    those compatibility lanes cannot leak into any shared picker.
    */
    return boardWorkflows.workflows
      .filter((workflow) => workflow.selectable !== false)
      .sort((a, b) => {
        if (a.id === boardWorkflows.defaultWorkflowId) return -1;
        if (b.id === boardWorkflows.defaultWorkflowId) return 1;
        return a.name.localeCompare(b.name);
      });
  }, [boardWorkflows, workflowMode]);

  const isAllWorkflowsSelected = selectedWorkflowId === ALL_WORKFLOWS_BOARD_VIEW_ID;

  const selectedWorkflow = useMemo<BoardWorkflowDefinition | null>(() => {
    if (!workflowMode) return null;
    return workflowOptions.find((workflow) => workflow.id === selectedWorkflowId)
      ?? workflowOptions.find((workflow) => workflow.id === boardWorkflows?.defaultWorkflowId)
      ?? workflowOptions[0]
      ?? null;
  }, [boardWorkflows?.defaultWorkflowId, selectedWorkflowId, workflowMode, workflowOptions]);

  useEffect(() => {
    if (!boardWorkflows) {
      return;
    }

    if (!workflowMode) {
      if (storedSelectionRef.current !== null) {
        removeBoardWorkflowSelection(projectId);
        storedSelectionRef.current = null;
      }
      setSelectedWorkflowIdState(null);
      return;
    }

    /*
    FNXC:WorkflowAggregation 2026-09-16-23:24:
    FN-483 : la vue agrégée est évaluée AVANT le cas mono-workflow. Board portait auparavant son propre état
    `isAllWorkflowsViewSelected` et écrivait le sentinel en contournant ce setter ; c'est pourquoi « All workflows »
    survivait à un projet ne proposant qu'un workflow sélectionnable. Maintenant que la sélection agrégée passe par ce
    chemin commun, la réparation ne doit pas l'effacer : seul un projet sans aucun workflow (`!workflowMode`,
    traité au-dessus) la retire.
    */
    if (isAllWorkflowsSelected) {
      return;
    }

    if (workflowOptions.length < 2) {
      if (storedSelectionRef.current !== null) {
        removeBoardWorkflowSelection(projectId);
        storedSelectionRef.current = null;
      }
      setSelectedWorkflowIdState(selectedWorkflow?.id ?? null);
      return;
    }

    if (selectedWorkflow && selectedWorkflow.id !== selectedWorkflowId) {
      const shouldRepairStoredSelection = storedSelectionRef.current !== null;
      setSelectedWorkflowIdState(selectedWorkflow.id);
      if (shouldRepairStoredSelection) {
        writeBoardWorkflowSelection(projectId, selectedWorkflow.id);
        storedSelectionRef.current = selectedWorkflow.id;
      }
    }
  }, [boardWorkflows, isAllWorkflowsSelected, projectId, selectedWorkflow, selectedWorkflowId, workflowMode, workflowOptions.length]);

  return {
    boardWorkflows,
    workflowMode,
    workflowOptions,
    selectedWorkflow,
    selectedWorkflowId,
    isAllWorkflowsSelected,
    setSelectedWorkflowId,
    refreshBoardWorkflows,
    setBoardWorkflowsState,
  };
}
