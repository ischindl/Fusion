import React from "react";
import { createRoot } from "react-dom/client";
import i18n from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import type { Column as ColumnType, Task } from "@fusion/core";
import { Board } from "./components/Board";
import { ToastProvider } from "./hooks/useToast";
import { ConfirmDialogProvider } from "./hooks/useConfirm";
import { NavigationHistoryProvider } from "./hooks/useNavigationHistory";
import { ViewLayoutProvider } from "./context/ViewLayoutContext";
/*
FNXC:BoardRendering 2026-11-13-15:05:
L'ordre d'injection reproduit `main.tsx` (feuilles de composants AVANT `styles.css`,
`ui-style-tokens.css`, `native-ui.css`) — la même raison que `board-scroll-e2e-fixture.tsx` : une cascade
inversée mesurerait un autre gagnant que la production, et ici le résultat mesuré EST une position de
rect-angle dans un viewport.
*/
import "./styles.css";
import "./ui-style-tokens.css";
import "./native-ui.css";

/*
FNXC:BoardOrdering 2026-11-13-15:05 (RUFU-526):
« une seule carte échouée parmi 200+ cartes inactives » est une affection du PREMIER ÉCRAN, donc un
RÉSULTAT RENDU : la position d'une carte dans le viewport dépend du tri client, de la troncature serveur,
de la virtualisation de `Column` et de la cascade CSS — aucun de cela n'existe en jsdom. Cette fixture
monte donc le VRAI `Board` derrière un stub HTTP déterministe, sans daemon, sans PostgreSQL, sans appel IA
et sans mock de composant.

LE STUB IMITE LE CONTRAT, PAS LE RÉSULTAT. La page générique du board est une lecture TRONQUÉE en création
croissante : la carte échouée, créée en dernier, n'y est PAS. C'est exactement le défaut rapporté. La carte
n'entre dans le DOM QUE si la lecture de tête de lane demande `order=attention` — le stub répond alors la
tête triée par attention. Une réponse à `order=queue` (le comportement d'avant RUFU-526) renvoie les 50
cartes inactives les plus anciennes SANS la carte échouée, comme le ferait le serveur : le test échoue au
lieu de recevoir la bonne réponse par générosité du fixture.

Chaque requête est enregistrée (`window.__boardAttentionRequests`) avec sa méthode, donc « cette lecture
n'a rien écrit » se vérifie sur le réseau et pas seulement sur l'absence d'écriture de store.
*/

localStorage.clear();
sessionStorage.clear();

const WORKFLOW_ID = "builtin:coding";
const FIRST_IDLE_INDEX = 1001;
const IDLE_COUNT = 200;
const FAILED_TASK_ID = "FN-0900";
const LANE_HEAD_LIMIT = 50;

const WORKFLOW = {
  id: WORKFLOW_ID,
  name: "Coding",
  columns: [
    // Première pane sur téléphone : atteindre `todo` demande un vrai pan à l'opérateur.
    { id: "ideas", name: "Ideas", flags: { intake: true, manualIntake: true } },
    { id: "todo", name: "Todo", flags: { hold: true } },
    { id: "in-progress", name: "In Progress", flags: { countsTowardWip: true } },
    { id: "in-review", name: "In Review", flags: { mergeBlocker: true } },
    { id: "done", name: "Done", flags: { complete: true } },
  ],
};

/** Horodatage d'ancrage : les inactives sont créées AVANT la carte échouée, comme dans la production. */
const IDLED_AT = Date.parse("2026-01-01T00:00:00.000Z");
const FAILED_AT = IDLED_AT + (IDLE_COUNT + 1) * 60_000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function card(id: string, column: string, createdAt: number, extra: Partial<Task> = {}): Task {
  const stamp = iso(createdAt);
  return {
    id,
    title: `Carte ${id}`,
    description: "",
    column: column as ColumnType,
    dependencies: [],
    steps: [],
    currentStep: 0,
    status: null,
    paused: false,
    error: null,
    log: [],
    createdAt: stamp,
    updatedAt: stamp,
    columnMovedAt: stamp,
    ...extra,
  } as Task;
}

/** Les 200 inactives de `todo`, en création croissante — l'ordre que la page générique du board livre. */
const IDLE_TODO: Task[] = Array.from({ length: IDLE_COUNT }, (_, index) => {
  const number = FIRST_IDLE_INDEX + index;
  return card(`FN-${number}`, "todo", IDLED_AT + index * 60_000);
});

/**
 * La carte cassée : tier 0 de l'échelle d'attention (`error` non vide), créée en DERNIER, donc absente de
 * la page générique tronquée et 201e par l'ordre d'arrivée — l'état exact du rapport opérateur.
 */
const FAILED_TASK = card(FAILED_TASK_ID, "todo", FAILED_AT, {
  status: "failed",
  error: "Le build de vérification a échoué : 3 tests rouges dans la lane de gate.",
});

/** Les autres lanes, petites : la géométrie mesurée ne doit rien à la taille d'une lane voisine. */
const OTHER_LANES: Task[] = [
  card("FN-0001", "ideas", IDLED_AT + 10_000),
  card("FN-0002", "ideas", IDLED_AT + 20_000),
  card("FN-0003", "in-progress", IDLED_AT + 30_000),
  card("FN-0004", "in-review", IDLED_AT + 40_000),
  card("FN-0005", "done", IDLED_AT + 50_000, { status: "done" }),
];

/*
FNXC:BoardOrdering 2026-11-13-15:05 (RUFU-526):
La page générique du board (`useTasks`, création croissante) livre les 200 inactives et PAS la carte
échouée, qui est la dernière créée. La condition mesurée est donc bien celle du rapport — une carte cassée
parmi 200 inactives — et la carte cassée ne peut entrer dans le DOM QUE par la tête de lane. C'est ce qui
fait de la géométrie mesurée la preuve des deux moitiés (requête `order=attention` + rang client) et non du
seul rang client.
*/
const BOARD_PAGE: Task[] = [...OTHER_LANES, ...IDLE_TODO];

export interface RecordedRequest {
  method: string;
  url: string;
  /** Le paramètre `order` réellement envoyé, pour que l'assertion de shape de requête lise le réseau. */
  order: string | null;
  columns: string | null;
  /** La revendication `reviewScope` réellement envoyée — une revendication, jamais un fait du serveur. */
  reviewScope: string | null;
}

const recordedRequests: RecordedRequest[] = [];
declare global {
  interface Window {
    __boardAttentionRequests?: RecordedRequest[];
  }
}
window.__boardAttentionRequests = recordedRequests;

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

/** Tête de lane triée par attention : la carte cassée en tête, puis les inactives les plus anciennes. */
function attentionHeadPage(): unknown {
  const tasks = [FAILED_TASK, ...IDLE_TODO.slice(0, LANE_HEAD_LIMIT - 1)];
  return { tasks, total: IDLE_COUNT + 1, hasMore: true, nextCursor: "attention-cursor" };
}

/**
 * Tête de lane en ordre d'arrivée (`queue`) : les 50 inactives les plus anciennes, SANS la carte créée en
 * dernier. C'est la réponse du serveur d'avant RUFU-526, et c'est ce qui rend la preuve faussable.
 */
function queueHeadPage(): unknown {
  const tasks = IDLE_TODO.slice(0, LANE_HEAD_LIMIT);
  return { tasks, total: IDLE_COUNT, hasMore: true, nextCursor: "queue-cursor" };
}

window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = (
    typeof init?.method === "string" ? init.method
      : typeof (input as Request).method === "string" ? (input as Request).method
        : "GET"
  ).toUpperCase();
  const queryIndex = url.indexOf("?");
  const search = new URLSearchParams(queryIndex >= 0 ? url.slice(queryIndex + 1) : "");
  recordedRequests.push({
    method,
    url,
    order: search.get("order"),
    columns: search.get("columns"),
    reviewScope: search.get("reviewScope"),
  });

  if (url.includes("/tasks/board-workflows")) {
    return jsonResponse({
      flagEnabled: true,
      defaultWorkflowId: WORKFLOW_ID,
      workflows: [WORKFLOW],
      taskWorkflowIds: {},
    });
  }
  if (url.includes("/tasks/page")) {
    const columns = search.get("columns") ?? "";
    if (!columns.includes("todo")) {
      return jsonResponse({ tasks: [], total: 0, hasMore: false, nextCursor: null });
    }
    return jsonResponse(search.get("order") === "attention" ? attentionHeadPage() : queueHeadPage());
  }
  if (url.includes("/settings") || url.includes("/project/")) return jsonResponse({});
  if (
    url.includes("/agents")
    || url.includes("/activity")
    || url.includes("/usage")
    || url.includes("/projects")
    || url.includes("/missions")
    || url.includes("/nodes")
    || url.includes("/plugins")
    || url.includes("/workflows")
  ) {
    return jsonResponse([]);
  }
  return jsonResponse({});
};

void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  resources: { en: { app: {} } },
  defaultNS: "app",
  interpolation: { escapeValue: false },
});

const noop = () => undefined;
const asyncNoop = async () => undefined;

function Fixture() {
  return (
    <I18nextProvider i18n={i18n}>
      <ToastProvider>
        <ConfirmDialogProvider>
          <NavigationHistoryProvider value={{ pushNav: noop, replaceCurrent: noop, removeNav: noop, promoteNav: noop }}>
            <ViewLayoutProvider projectId="project-1">
              {/* App ne rend aucun conteneur supplémentaire entre #root et .project-content. */}
              <div className="project-content project-content--with-mobile-nav">
                <Board
                  tasks={BOARD_PAGE}
                  projectId="project-1"
                  maxConcurrent={2}
                  maxWorktrees={4}
                  showWorktreeGrouping={false}
                  onMoveTask={asyncNoop as never}
                  onOpenDetail={noop}
                  addToast={noop}
                  onNewTask={noop}
                  autoMerge
                  planAutoApproveEnabled={false}
                  onTogglePlanAutoApprove={asyncNoop as never}
                />
              </div>
            </ViewLayoutProvider>
          </NavigationHistoryProvider>
        </ConfirmDialogProvider>
      </ToastProvider>
    </I18nextProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
