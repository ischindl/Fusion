import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";

/*
FNXC:PostMergeEvidenceContract 2026-11-05-04:13 (RUFU-456):
Component-level tests for the post-merge optional-group inspector's evidence-contract UI. Mirrors the
WorkflowNodeEditor.test.tsx api-mock harness; the editor's plain `fetch` calls (post-merge-evidence
status line, cli-agents) are stubbed globally per URL. The assertions encode the display contract:
Inherit (absent) is never shown as Full Suite, the status line names the effective inherited contract,
revert-to-Inherit DELETES the evidence key, the pre-merge group grows no evidence row, a 422 from the
server surfaces its WorkflowIrError sentence verbatim, and the controls live in ONE responsive DOM tree
(no breakpoint-gated duplicate copies of the select).
*/

vi.mock("../../api", () => ({
  fetchWorkflows: vi.fn(),
  createWorkflow: vi.fn(),
  updateWorkflow: vi.fn(),
  deleteWorkflow: vi.fn(),
  exportWorkflow: vi.fn(),
  importWorkflow: vi.fn(),
  designWorkflow: vi.fn(),
  ApiRequestError: class ApiRequestError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "ApiRequestError";
      this.status = status;
    }
  },
  fetchTraits: vi.fn(),
  fetchStepParsers: vi.fn(),
  fetchModels: vi.fn(),
  fetchAgents: vi.fn(),
  fetchDiscoveredSkills: vi.fn(),
  fetchWorkflowStepTemplates: vi.fn().mockResolvedValue({ templates: [] }),
  fetchPluginWorkflowStepTemplates: vi.fn().mockResolvedValue({ templates: [] }),
  fetchConfig: vi.fn(),
  fetchSettings: vi.fn(),
  updateSettings: vi.fn(),
  updateGlobalSettings: vi.fn(),
  fetchWorkflowSettingValues: vi.fn().mockResolvedValue({ stored: {}, effective: {}, orphaned: [] }),
  updateWorkflowSettingValues: vi.fn().mockResolvedValue({ stored: {}, effective: {}, orphaned: [] }),
  fetchWorkflowPromptOverrides: vi.fn().mockResolvedValue({ stored: {}, effective: {}, defaults: {} }),
  updateWorkflowPromptOverrides: vi.fn().mockResolvedValue({ stored: {}, effective: {}, defaults: {} }),
}));

import { fetchWorkflows, fetchTraits, fetchStepParsers, updateWorkflow, fetchModels, fetchAgents, fetchConfig, fetchSettings, ApiRequestError } from "../../api";
import { WorkflowNodeEditor } from "../WorkflowNodeEditor";
import { POST_MERGE_EVIDENCE_KINDS, describePostMergeEvidenceKinds } from "@fusion/core";
import type { WorkflowDefinition } from "@fusion/core";
import type { TraitCatalogEntry } from "../../api";

function mockDesktopViewport(): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

const TRAIT_CATALOG: TraitCatalogEntry[] = [
  { id: "intake", name: "Intake", builtin: true, flags: { intake: true } },
  { id: "complete", name: "Complete", builtin: true, flags: { complete: true } },
  { id: "wip", name: "WIP", builtin: true, flags: { countsTowardWip: true } },
  { id: "hold", name: "Hold", builtin: true, flags: { hold: true } },
];

const ONDEV_CONTRACT = {
  provider: "onedev",
  reason: "onedev-endpoint",
  endpointHost: "onedev.example.test:6610",
  credentialConfigured: true,
};

function definition(opts: { evidenceKind?: string; phase?: string } = {}): WorkflowDefinition {
  const config: Record<string, unknown> = {
    defaultOn: false,
    name: "Post merge",
    phase: opts.phase ?? "post-merge",
    // A revision budget the evidence select must not clobber (spec item b names maxRevisions explicitly).
    maxRevisions: 3,
    template: { nodes: [{ id: "gate", kind: "prompt", config: { prompt: "record evidence" } }], edges: [] },
  };
  if (opts.evidenceKind) config.evidence = { kind: opts.evidenceKind };
  return {
    id: "WF-PME",
    kind: "workflow",
    name: "Evidence",
    description: "",
    ir: {
      version: "v2",
      name: "Evidence",
      columns: [
        { id: "plan", name: "Plan", traits: [{ trait: "intake" }] },
        { id: "in-progress", name: "In progress", traits: [] },
        { id: "done", name: "Done", traits: [{ trait: "complete" }] },
      ],
      nodes: [
        { id: "start", kind: "start", column: "plan" },
        { id: "opt", kind: "optional-group", column: "in-progress", config },
        { id: "end", kind: "end", column: "done" },
      ],
      edges: [
        { from: "start", to: "opt", condition: "success" },
        { from: "opt", to: "end", condition: "success" },
      ],
    },
    layout: {},
    createdAt: "2026-11-05T00:00:00.000Z",
    updatedAt: "2026-11-05T00:00:00.000Z",
  };
}

/** Stub the editor's plain fetches: the evidence contract route plus any incidental route. */
function stubFetch(contract: unknown): void {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.startsWith("/api/post-merge-evidence")) {
      return { ok: true, json: async () => ({ contract }) };
    }
    return { ok: true, json: async () => ({}) };
  }));
}

async function openAndSelectNode(def: WorkflowDefinition) {
  vi.mocked(fetchWorkflows).mockResolvedValue([def]);
  render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
  await screen.findByText("Save");
  // The default desktop canvas is Simple view, where the optional-group card renders as
  // wf-simple-node-optional-group; the ReactFlow wrapper carries .react-flow__node-optional-group
  // in BOTH view modes, so node selection clicks go through that stable class.
  const node = await waitFor(() => {
    const el = document.querySelector(".react-flow__node-optional-group");
    if (!el) throw new Error("optional-group node not mounted yet");
    return el as HTMLElement;
  });
  fireEvent.click(node);
  return node;
}

beforeEach(() => {
  mockDesktopViewport();
  vi.mocked(fetchTraits).mockResolvedValue(TRAIT_CATALOG);
  vi.mocked(fetchStepParsers).mockResolvedValue(["step-headings", "json-steps"]);
  vi.mocked(fetchModels).mockResolvedValue({ models: [] as never[], favoriteProviders: [], favoriteModels: [] });
  vi.mocked(fetchAgents).mockResolvedValue([]);
  vi.mocked(fetchConfig).mockResolvedValue({ maxConcurrent: 2, effectiveMaxConcurrent: 2, concurrencyBindingKnob: "maxConcurrent", rootDir: "." } as never);
  vi.mocked(fetchSettings).mockResolvedValue({} as never);
  vi.mocked(updateWorkflow).mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WorkflowNodeEditor post-merge evidence contract inspector", () => {
  it("renders the Inherit + four-kind select and defaults an untouched node to Inherit", async () => {
    stubFetch(ONDEV_CONTRACT);
    await openAndSelectNode(definition());
    const select = (await screen.findByTestId("wf-optional-group-evidence-kind")) as HTMLSelectElement;
    expect(select.value).toBe("");
    expect([...select.options].map((o) => o.value)).toEqual(["", "github-actions-full-suite", "integration-only", "onedev-pipeline", "gitlab-pipeline"]);
    expect(select.options[0].text).toContain("Inherit");
    // Absent is Inherit, never a pre-selected Full Suite.
    expect(select.options[1].value).toBe("github-actions-full-suite");
  });

  it("shows the derived status line and names the inherited resolution, dropping it once a kind is authored", async () => {
    stubFetch(ONDEV_CONTRACT);
    await openAndSelectNode(definition());
    const status = await screen.findByTestId("wf-optional-group-evidence-status");
    expect(status).toHaveTextContent("OneDev");
    expect(status).toHaveTextContent("derived: this repo's remote matches a configured OneDev endpoint");
    expect(status).toHaveTextContent("onedev.example.test:6610");
    expect(status).toHaveTextContent("credential configured");
    // Inherit + OneDev board resolves to the platform pipeline, NEVER the historical Full Suite reading.
    expect(status).toHaveTextContent("resolves to OneDev pipeline");
    expect(status).not.toHaveTextContent("resolves to GitHub Actions Full Suite");

    fireEvent.change(screen.getByTestId("wf-optional-group-evidence-kind"), { target: { value: "integration-only" } });
    await waitFor(() => expect(screen.getByTestId("wf-optional-group-evidence-status")).not.toHaveTextContent("resolves to"));
  });

  it("renders a plain (non-endpoint) reason and names Full Suite as the inherit resolution on a no-reporter board", async () => {
    stubFetch({ provider: "none", reason: "no-remote" });
    await openAndSelectNode(definition());
    const status = await screen.findByTestId("wf-optional-group-evidence-status");
    expect(status).toHaveTextContent("None (no CI reporter)");
    expect(status).toHaveTextContent("derived: this repository has no git remote");
    // An endpoint-derived fact the contract never carried must not be invented by the UI.
    expect(status).not.toHaveTextContent("pipeline at");
    expect(status).not.toHaveTextContent("credential configured");
    // provider `none` keeps the historical reading, and the line says so instead of guessing a platform.
    expect(status).toHaveTextContent("resolves to GitHub Actions Full Suite");
  });

  it("hides the status line entirely when the contract cannot be observed", async () => {
    stubFetch(null);
    await openAndSelectNode(definition());
    await screen.findByTestId("wf-optional-group-evidence-kind");
    expect(screen.queryByTestId("wf-optional-group-evidence-status")).not.toBeInTheDocument();
  });

  // Each authored kind is a real authored choice — including the one that equals the historical default,
  // which on a OneDev/GitLab board is a different answer from Inherit.
  it.each([...POST_MERGE_EVIDENCE_KINDS])("persists authored kind %s and preserves every other config key", async (kind) => {
    stubFetch(null);
    const def = definition();
    vi.mocked(updateWorkflow).mockImplementation(async (_id, updates) => ({ ...def, ...(updates as object) }));
    await openAndSelectNode(def);
    fireEvent.change(await screen.findByTestId("wf-optional-group-evidence-kind"), { target: { value: kind } });
    fireEvent.click(screen.getByText("Save").closest("button")!);
    await waitFor(() => expect(updateWorkflow).toHaveBeenCalledTimes(1));
    const savedIr = (vi.mocked(updateWorkflow).mock.calls[0][1] as { ir: WorkflowDefinition["ir"] }).ir;
    const config = savedIr.nodes.find((node) => node.id === "opt")?.config as Record<string, unknown>;
    expect(config?.evidence).toEqual({ kind });
    expect(config?.phase).toBe("post-merge");
    expect(config?.defaultOn).toBe(false);
    expect(config?.name).toBe("Post merge");
    expect(config?.maxRevisions).toBe(3);
    expect(config?.template).toBeTruthy();
  });

  it("reverting to Inherit DELETES the evidence key (never persists an evidence:{} shell)", async () => {
    stubFetch(null);
    const def = definition({ evidenceKind: "gitlab-pipeline" });
    vi.mocked(updateWorkflow).mockImplementation(async (_id, updates) => ({ ...def, ...(updates as object) }));
    await openAndSelectNode(def);
    const select = (await screen.findByTestId("wf-optional-group-evidence-kind")) as HTMLSelectElement;
    expect(select.value).toBe("gitlab-pipeline");
    fireEvent.change(select, { target: { value: "" } });
    expect(select.value).toBe("");
    fireEvent.click(screen.getByText("Save").closest("button")!);
    await waitFor(() => expect(updateWorkflow).toHaveBeenCalledTimes(1));
    const savedIr = (vi.mocked(updateWorkflow).mock.calls[0][1] as { ir: WorkflowDefinition["ir"] }).ir;
    const config = savedIr.nodes.find((node) => node.id === "opt")?.config;
    expect(config).not.toHaveProperty("evidence");
    expect(config?.phase).toBe("post-merge");
  });

  it("grows no evidence row on a pre-merge optional-group", async () => {
    stubFetch(ONDEV_CONTRACT);
    await openAndSelectNode(definition({ phase: "pre-merge" }));
    await screen.findByTestId("wf-optional-group-max-revisions");
    expect(screen.queryByTestId("wf-optional-group-evidence-kind")).not.toBeInTheDocument();
    expect(screen.queryByTestId("wf-optional-group-evidence-status")).not.toBeInTheDocument();
  });

  it("renders one responsive DOM tree — a single select/status pair in the shared inspector classes", async () => {
    stubFetch(ONDEV_CONTRACT);
    await openAndSelectNode(definition({ evidenceKind: "onedev-pipeline" }));
    await screen.findByTestId("wf-optional-group-evidence-status");
    const selects = screen.queryAllByTestId("wf-optional-group-evidence-kind");
    expect(selects).toHaveLength(1);
    // Same shared inspector primitives as the pre-existing rows (no forked mobile/desktop variant):
    const field = selects[0].closest("label");
    expect(field).toHaveClass("wf-field");
    const checkbox = screen.getByTestId("wf-optional-group-default-on").closest("label");
    expect(checkbox).toHaveClass("wf-field");
    expect(field!.parentElement).toBe(checkbox!.parentElement);
    const statusNode = screen.getByTestId("wf-optional-group-evidence-status");
    expect(statusNode).toHaveTextContent(/credential configured/);
  });

  it("surfaces a 422 invalid-kind refusal from the server verbatim and badges the node", async () => {
    stubFetch(null);
    const def = definition();
    // The sentence is the server's, generated by core's describePostMergeEvidenceKinds() — the test builds
    // it the same way so it can never drift into a stale hand-copied kind list.
    const refusal = `optional-group node 'opt' evidence.kind must be ${describePostMergeEvidenceKinds()}`;
    vi.mocked(updateWorkflow).mockRejectedValue(new ApiRequestError(refusal, 422));
    await openAndSelectNode(def);
    fireEvent.change(await screen.findByTestId("wf-optional-group-evidence-kind"), { target: { value: "integration-only" } });
    fireEvent.click(screen.getByText("Save").closest("button")!);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("optional-group node 'opt' evidence.kind must be");
    expect(alert).toHaveTextContent(refusal);
    // Every kind in the core allow-list is named — a two-kind copy of this message would fail here.
    for (const kind of POST_MERGE_EVIDENCE_KINDS) {
      expect(alert).toHaveTextContent(kind);
    }
  });
});
