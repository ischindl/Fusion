import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { TaskCard } from "../TaskCard";

/*
FNXC:CrossProjectHandoff 2026-09-09-12:37 (RUFU-203):
Host-level proof that the transfer request carries the SOURCE card's project scope. The unit test for
`runTransferTaskAction` can only show that an argument was handed to an injected fake; the failure the
review lane caught was one layer further out — every production host passed the raw imported
`transferTask`, whose signature silently dropped the scope, and `api()` injects no project scope of
its own. So this suite drives the REAL chain a click takes (card context menu → shared transfer
helper → real API client → fetch) and asserts the wire URL.

Why the URL is the assertion that matters: the server resolves the source project as
`request projectId ?? engine.getProjectId()` — the daemon's LAUNCH project. An unscoped transfer of a
card viewed from another project therefore reads the id against the wrong store and answers 404, or
(on an id collision) copies and stamps the WRONG card. Only the query parameter distinguishes the two
outcomes, so the fake stands in for exactly one thing the operator decides: the picker selection.
*/

const PICKER_SELECTION = { targetProjectId: "proj-target", disposition: "keep-transferred" } as const;

// Fakes ONLY the operator's decision inside the lazily-mounted picker; everything downstream is real.
vi.mock("../../hooks/useTaskTransferModal", () => ({
  useTaskTransferModal: () => ({
    requestTransfer: vi.fn(async () => PICKER_SELECTION),
    transferModal: null,
  }),
}));

vi.mock("../../hooks/useToast", () => ({
  useOptionalToast: () => null,
  useToast: () => ({ addToast: vi.fn(), removeToast: vi.fn(), toasts: [] }),
}));

/*
Spread the real module so `transferTask` is the actual client (that is the code under test) while the
other reads the card performs on mount stay off the network.
*/
vi.mock("../../api", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  fetchWorkflowSettingValues: vi.fn(async () => ({ stored: {}, effective: {}, orphaned: [] })),
  fetchBoardWorkflows: vi.fn(async () => ({ workflows: [] })),
  fetchMission: vi.fn(async () => null),
  fetchAgent: vi.fn(async () => null),
  fetchAgents: vi.fn(async () => []),
  fetchTaskDetail: vi.fn(async () => null),
  refreshPrStatus: vi.fn(async () => null),
  rebuildTaskSpec: vi.fn(),
  fetchHandoffStatus: vi.fn(async () => ({ handoffs: [] })),
}));

vi.mock("../../hooks/useBadgeWebSocket", () => ({
  useBadgeWebSocket: () => ({ badgeUpdates: new Map(), isConnected: false, subscribeToBadge: vi.fn(), unsubscribeFromBadge: vi.fn() }),
}));
vi.mock("../../hooks/useSessionFiles", () => ({ useSessionFiles: () => ({ files: [], loading: false }) }));
vi.mock("../../hooks/useTaskDiffStats", () => ({ useTaskDiffStats: () => ({ stats: null, loading: false }) }));
vi.mock("../../hooks/useAgentsMapCache", () => ({
  useAgentsMapCache: () => ({ agentsMap: new Map(), agents: [], loading: false, refresh: vi.fn() }),
}));
vi.mock("../ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../PluginSlot", () => ({ PluginSlot: () => null }));

const noop = () => {};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "STAS-042",
    title: "Hand this card to Fusion",
    column: "todo",
    status: "pending" as Task["status"],
    steps: [],
    dependencies: [],
    description: "",
    ...overrides,
  } as Task;
}

/** Stub fetch for every request the card makes; returns an empty JSON body except for the transfer. */
function stubFetch() {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/transfer")) {
      return Response.json({
        targetProjectId: "proj-target",
        targetProjectName: "Target Project",
        targetTaskId: "FUS-1001",
        deduped: false,
      });
    }
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

async function openMenuAndPickTransfer() {
  fireEvent.contextMenu(document.querySelector(".card")!, { clientX: 24, clientY: 28 });
  const item = await screen.findByRole("menuitem", { name: /Transfer to project/ });
  fireEvent.click(item);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TaskCard transfer scoping (host → client)", () => {
  it("posts the transfer to the source card's project scope", async () => {
    const { calls } = stubFetch();
    render(
      <TaskCard
        task={makeTask()}
        projectId="proj-stash"
        onOpenDetail={noop}
        onUpdateTask={noop}
        addToast={noop}
      />,
    );

    await openMenuAndPickTransfer();

    await waitFor(() => {
      const transfer = calls.find((url) => url.includes("/transfer"));
      expect(transfer).toBeDefined();
      const url = new URL(transfer!, "http://localhost:4040");
      expect(url.pathname).toBe("/api/tasks/STAS-042/transfer");
      // The parameter is the whole point: without it the server binds the SOURCE store to whatever
      // project the daemon was launched against and the card is not found.
      expect(url.searchParams.get("projectId")).toBe("proj-stash");
    });
  });

  it("sends the target selection in the body while the query names the source project", async () => {
    const { fetchMock } = stubFetch();
    render(
      <TaskCard
        task={makeTask({ id: "STAS-043" })}
        projectId="proj-stash"
        onOpenDetail={noop}
        onUpdateTask={noop}
        addToast={noop}
      />,
    );

    await openMenuAndPickTransfer();

    await waitFor(() => {
      const transferCall = fetchMock.mock.calls.find(([input]) => String(input).includes("/transfer"));
      expect(transferCall).toBeDefined();
      const [, init] = transferCall!;
      expect((init as RequestInit).method).toBe("POST");
      expect(JSON.parse(String((init as RequestInit).body))).toEqual({
        targetProjectId: "proj-target",
        disposition: "keep-transferred",
      });
    });
  });
});
