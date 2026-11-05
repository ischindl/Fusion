import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MergeSection } from "../MergeSection";
import type { MergeSectionProps } from "../MergeSection";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
    text: async () => typeof body === "string" ? body : JSON.stringify(body),
  } as Response;
}

/*
FNXC:PostMergeEvidenceContract 2026-11-05-07:20 (RUFU-456):
MergeSection now reads `GET /api/post-merge-evidence` once on mount to render the reporter status line.
The previous fixtures chained `mockResolvedValueOnce`, so that mount read consumed the first queued
maintenance response and the stamp-cleanup list rendered empty — the failure mode was invisible in the
assertion text ("unable to find the apply button") and real in the harness (an order-dependent mock).
Every case now routes by URL: the contract read answers `contract: null` (these cases are about the stamp
row, not the status line) and each maintenance endpoint answers its own body. A route body may be a
function so a state transition (scan → apply → re-scan empty) stays expressible without call ordering.
*/
function stubFetchByRoute(routes: Record<string, unknown | (() => unknown)>): ReturnType<typeof vi.fn> {
  // Longest route first: `/…/apply` is a suffix-superstring of `/…/legacy-automerge-stamps`.
  const ordered = Object.entries(routes).sort(([a], [b]) => b.length - a.length);
  const mock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.startsWith("/api/post-merge-evidence")) return jsonResponse({ contract: null });
    for (const [route, body] of ordered) {
      if (url.includes(route)) return jsonResponse(typeof body === "function" ? (body as () => unknown)() : body);
    }
    throw new Error(`unexpected fetch in legacy-automerge-stamp harness: ${url}`);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function makeProps(overrides: Partial<MergeSectionProps["form"]> = {}, projectId?: string): MergeSectionProps {
  return {
    form: {
      autoMerge: true,
      planApprovalMode: "workflow",
      merger: { mode: "ai" },
      testMode: false,
      mergeStrategy: "direct",
      ...overrides,
    } as MergeSectionProps["form"],
    setForm: vi.fn(),
    integrationBranchOptions: ["main"],
    integrationBranchCustomMode: false,
    setIntegrationBranchCustomMode: vi.fn(),
    // FNXC:SettingsReadPath 2026-10-09-12:43: each case gets its own project key because the scan result
    // is cached per project for the session; a shared key would leak one test's scan into the next.
    projectId,
  };
}

describe("MergeSection legacy auto-merge stamp cleanup", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.innerWidth = 1024;
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("renders and updates the project-scoped plan approval mode select", async () => {
    stubFetchByRoute({});
    const props = makeProps({ planApprovalMode: "require-all" });

    render(<MergeSection {...props} />);

    const select = screen.getByTestId("plan-approval-mode-select") as HTMLSelectElement;
    expect(select.value).toBe("require-all");
    expect(screen.getByRole("option", { name: "Use workflow setting" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Auto-approve all tasks (default)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Require approval for all tasks" })).toBeInTheDocument();

    fireEvent.change(select, { target: { value: "auto-approve-all" } });

    expect(props.setForm).toHaveBeenCalledWith(expect.any(Function));
    const updater = vi.mocked(props.setForm).mock.calls.at(-1)?.[0] as (state: MergeSectionProps["form"]) => MergeSectionProps["form"];
    expect(updater(props.form).planApprovalMode).toBe("auto-approve-all");
  });

  it("renders the store-provided candidate list without client-side filtering", async () => {
    const fetchMock = stubFetchByRoute({
      "/api/maintenance/legacy-automerge-stamps": {
        candidates: [
          { taskId: "FN-101", column: "in-review", cleared: false },
          { taskId: "FN-USER", column: "in-review", cleared: false },
        ],
        count: 2,
      },
    });

    render(<MergeSection {...makeProps({}, "scan-list")} />);

    // Opening the section must not trigger a SCAN: cleanup is operator-triggered. (The section's only
    // other mount read — the reporter contract — is not a maintenance call and is not what this guards.)
    expect(await screen.findByTestId("legacy-automerge-stamp-idle-state")).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/maintenance"))).toEqual([]);
    fireEvent.click(screen.getByTestId("legacy-automerge-stamp-scan-button"));

    await waitFor(() => expect(screen.getByText("FN-101")).toBeInTheDocument());
    expect(screen.getByText("FN-USER")).toBeInTheDocument();
    expect(screen.getAllByTestId("legacy-automerge-stamp-candidate-row")).toHaveLength(2);
    expect(screen.getByTestId("legacy-automerge-stamp-apply-button")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/maintenance/legacy-automerge-stamps");
  });

  it("renders an explicit empty state and no apply shell when there are zero candidates", async () => {
    stubFetchByRoute({ "/api/maintenance/legacy-automerge-stamps": { candidates: [], count: 0 } });

    render(<MergeSection {...makeProps({}, "scan-empty")} />);

    fireEvent.click(await screen.findByTestId("legacy-automerge-stamp-scan-button"));
    expect(await screen.findByTestId("legacy-automerge-stamp-empty-state")).toHaveTextContent(
      "No legacy auto-merge stamps to clean up.",
    );
    expect(screen.queryByTestId("legacy-automerge-stamp-apply-button")).not.toBeInTheDocument();
  });

  it("requires confirmation, posts apply, and re-fetches to the empty state", async () => {
    // The scan route's own queue models the state transition the once-chain used to model by call order.
    const scanQueue = [
      { candidates: [{ taskId: "FN-101", column: "in-review", cleared: false }], count: 1 },
      { candidates: [], count: 0 },
    ];
    const fetchMock = stubFetchByRoute({
      "/api/maintenance/legacy-automerge-stamps/apply": {
        cleared: [{ taskId: "FN-101", column: "in-review", cleared: true }],
        count: 1,
      },
      "/api/maintenance/legacy-automerge-stamps": () => scanQueue.shift() ?? { candidates: [], count: 0 },
    });

    render(<MergeSection {...makeProps({}, "scan-apply")} />);

    fireEvent.click(await screen.findByTestId("legacy-automerge-stamp-scan-button"));
    fireEvent.click(await screen.findByTestId("legacy-automerge-stamp-apply-button"));

    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("never touches genuine per-task overrides"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/maintenance/legacy-automerge-stamps/apply",
      { method: "POST" },
    ));
    expect(await screen.findByTestId("legacy-automerge-stamp-empty-state")).toBeInTheDocument();
  });

  it("is operable at a narrow mobile width", async () => {
    window.innerWidth = 390;
    stubFetchByRoute({
      "/api/maintenance/legacy-automerge-stamps": {
        candidates: [{ taskId: "FN-MOBILE", column: "in-review", cleared: false }],
        count: 1,
      },
    });

    render(<MergeSection {...makeProps({}, "scan-mobile")} />);

    fireEvent.click(await screen.findByTestId("legacy-automerge-stamp-scan-button"));
    expect(await screen.findByText("FN-MOBILE")).toBeInTheDocument();
    const applyButton = screen.getByTestId("legacy-automerge-stamp-apply-button");
    expect(applyButton.tagName).toBe("BUTTON");
    expect(applyButton).toHaveTextContent("Apply cleanup");
  });
});
