import React from "react";
import { createRoot } from "react-dom/client";
import i18n from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import type { Column as ColumnType, Task } from "@fusion/core";
import { Board } from "./components/Board";
import { ExternalBlockNotice } from "./components/TaskCard";
import { ToastProvider } from "./hooks/useToast";
import { ConfirmDialogProvider } from "./hooks/useConfirm";
import { NavigationHistoryProvider } from "./hooks/useNavigationHistory";
import { ViewLayoutProvider } from "./context/ViewLayoutContext";
/*
FNXC:ExternalBlockUx 2026-11-09-10:07 (RUFU-492):
Injection order reproduces `main.tsx` (component CSS via the imports above BEFORE `styles.css`,
`ui-style-tokens.css`, `native-ui.css`). An inverted cascade would measure a different winner than
production for same-specificity selectors — and the clamp/ceiling cascade of the external-block notice
is exactly what is under test here.
*/
import "./styles.css";
import "./ui-style-tokens.css";
import "./native-ui.css";

/*
FNXC:ExternalBlockUx 2026-11-09-10:07 (RUFU-492):
RUFU-492: the operator's report — an agent-authored ~70-line obstacle reason on a blocked card painting
over the next column and the dock, with the NEXT card drawn inside this one — is a RENDERED result.
jsdom computes no layout at all (which is why the shipped guard could only read the CSS file as text),
so this fixture mounts the REAL `Board` behind a deterministic `window.fetch` stub — no daemon, no
PostgreSQL, no AI call — seeded with the blocked task plus one neighbour directly below it in the same
column, which is the exact pair the virtualized row measurement must keep disjoint.

Surfaces exposed through `?surface=`:
- `board`    : the real Board (default). The blocked card lives in `column-virtual-row`; the neighbour
               below it is the overlapped-card proof.
- `variants` : three `ExternalBlockNotice` nodes (card / list / detail) of identical width carrying the
               SAME long reason, so the unclamped `--list` / `--detail` paint is compared against the
               clamped card-face paint in one page, through the real variant selectors.
*/
const params = new URLSearchParams(window.location.search);
const surface = params.get("surface") ?? "board";
localStorage.clear();
sessionStorage.clear();

const WORKFLOW = {
  id: "builtin:coding",
  name: "Coding",
  columns: [
    { id: "todo", name: "Todo", flags: { hold: true } },
    { id: "in-progress", name: "In Progress", flags: {} },
    { id: "in-review", name: "In Review", flags: { review: true } },
    { id: "blocked", name: "Blocked", flags: {} },
    { id: "done", name: "Done", flags: { complete: true } },
  ],
};

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

window.fetch = async (input: RequestInfo | URL): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.includes("/board-workflows") || url.includes("/workflows")) {
    return jsonResponse({ defaultWorkflowId: WORKFLOW.id, workflows: [WORKFLOW], taskWorkflowIds: {} });
  }
  if (url.includes("/settings")) return jsonResponse({});
  if (
    url.includes("/nodes")
    || url.includes("/agents")
    || url.includes("/missions")
    || url.includes("/roadmaps")
    || url.includes("/goals")
    || url.includes("/tasks")
    || url.includes("/plugins")
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
/* `onRetryTask` is contractually `(id) => Promise<Task>`; the fixture never retries, so the stub is a bottom-typed promise. */
const retryTaskStub = async (_id: string): Promise<never> => undefined as never;

/*
The measured live shape (project `stash`, STAS-285): an agent writing its whole reasoning into the
obstacle message. Same generator as the shipped `LONG_REASON` fixture — > 3 000 chars, ~70 rendered
lines — so the fixture reproduces the reported input, not a milder one.
*/
const LONG_REASON = Array.from(
  { length: 70 },
  (_, i) => `line ${i}: REPAIR ladder evidence, publish.yml protection_rules [] and trunk divergence.`,
).join("\n");

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

/*
`branchProgress` is an additive engine-populated payload field: `TaskCard` reads it through its own local
`TaskWithBranchProgress = Task & { branchProgress?: BranchProgressEntry[] }` because it is NOT part of the
persisted `Task` contract (`packages/core`). The fixture mirrors that shape so the fixture's cast states the
same intent the component states, instead of widening to `unknown`.
*/
interface FixtureBranchProgressEntry {
  branch: string;
  status: "pending" | "in-progress" | "completed" | "failed";
}

function baseTask(id: string, column: string, title: string): Task {
  return {
    id,
    title,
    description: "",
    column: column as ColumnType,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    columnMovedAt: TIMESTAMP,
  } as Task;
}

/*
FNXC:ExternalBlockUx 2026-11-09-18:16 (RUFU-492 code review P0):
The ceiling's safety argument is only as strong as the shape it is measured against. A blocked task with a
43-character title and no header badges measures the MILD shape, where the ceiling happens to have slack;
the shape that actually broke is a multi-line title plus header badges that wrap, because those two
identity rows are what grew past the budget while `.card` (display: block, overflow: visible) could not
clip the excess. So the blocked fixture carries a long title and five header chips (paused, fast mode,
decision-only, mission, parallel-branch progress) — the populated header a real blocked/paused card carries
— and the spec asserts the header and title really wrapped, so the non-crush assertions cannot pass on a
vacuously mild card.
*/
const BLOCKED_TASK = {
  ...baseTask(
    "STAS-285",
    "in-progress",
    "Blocked: lockfile drift in every plugin workspace leaves the publish job refusing and no lane able to pin its own dependencies",
  ),
  status: "blocked",
  paused: true,
  pausedReason: "external-block",
  size: "M",
  executionMode: "fast",
  noCommitsExpected: true,
  missionId: "M-001",
  // One more wide header chip, so the badges group wraps at every measured width and not only on the
  // desktop column (measured: the four static chips still fit one row inside a 282 px board card).
  branchProgress: [
    { branch: "fusion/stale-branch-a", status: "in-progress" },
    { branch: "fusion/stale-branch-b", status: "completed" },
    { branch: "fusion/stale-branch-c", status: "failed" },
  ] as FixtureBranchProgressEntry[],
  externalBlock: {
    origin: "network",
    code: "ETIMEDOUT",
    message: LONG_REASON,
    source: "session-failure",
  },
} as Task & { branchProgress: FixtureBranchProgressEntry[] };

const NEIGHBOUR_TASK = baseTask("STAS-286", "in-progress", "Neighbour task painted after the blocked one");

const TASKS: Task[] = [BLOCKED_TASK, NEIGHBOUR_TASK];

function Fixture() {
  if (surface === "variants") {
    // Equal widths keep the line-wrap identical across the three variants, so the height comparison
    // isolates the clamp itself. The card node here has no `.card.external-blocked` ancestor by
    // design: it proves the clamp mechanism binds without the ceiling custom property resolving.
    return (
      <I18nextProvider i18n={i18n}>
        <div data-testid="external-block-variants" style={{ width: 480, margin: "24px auto 0" }}>
          <div data-variant-host="card" style={{ containerType: "inline-size" }}>
            <ExternalBlockNotice task={BLOCKED_TASK} variant="card" onOpenChatWithPrefill={noop} onRetryTask={retryTaskStub} addToast={noop} />
          </div>
          <div data-variant-host="list" style={{ containerType: "inline-size" }}>
            <ExternalBlockNotice task={BLOCKED_TASK} variant="list" onOpenChatWithPrefill={noop} onRetryTask={retryTaskStub} addToast={noop} />
          </div>
          <div data-variant-host="detail" style={{ containerType: "inline-size" }}>
            <ExternalBlockNotice task={BLOCKED_TASK} variant="detail" onOpenChatWithPrefill={noop} onRetryTask={retryTaskStub} addToast={noop} />
          </div>
        </div>
      </I18nextProvider>
    );
  }

  return (
    <I18nextProvider i18n={i18n}>
      <ToastProvider>
        <ConfirmDialogProvider>
          <NavigationHistoryProvider value={{ pushNav: noop, replaceCurrent: noop, removeNav: noop, promoteNav: noop }}>
            <ViewLayoutProvider projectId="project-1">
              {/* App renders no extra container between #root and .project-content. */}
              <div className="project-content project-content--with-mobile-nav">
                <Board
                  tasks={TASKS}
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
                  onOpenChatWithPrefill={noop}
                  onRetryTask={asyncNoop as never}
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
