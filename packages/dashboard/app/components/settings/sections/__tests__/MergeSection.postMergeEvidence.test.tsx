import { useState } from "react";
import type { JSX } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MergeSection } from "../MergeSection";
import type { MergeSectionProps } from "../MergeSection";

/*
FNXC:PostMergeEvidenceContract 2026-11-05-04:13 (RUFU-456):
Component-level (not CSS-level) assertions for the Settings → Merge reporter row. The section only owns
form state — SettingsModal owns persistence — so the payload-equality assertions read the form echo the
harness mirrors, which is exactly what the shell serializes into the PUT.
*/

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));

/** Contract the stubbed GET /api/post-merge-evidence answers with (null = unobservable board). */
function makeProps(overrides: Partial<MergeSectionProps["form"]> = {}): MergeSectionProps {
  return {
    form: { autoMerge: true, planApprovalMode: "workflow", merger: { mode: "ai" }, testMode: false, mergeStrategy: "pull-request", ...overrides } as MergeSectionProps["form"],
    setForm: vi.fn(),
    integrationBranchOptions: ["main"],
    integrationBranchCustomMode: false,
    setIntegrationBranchCustomMode: vi.fn(),
  };
}

function ReporterHarness({ initial }: { initial?: unknown }): JSX.Element {
  const [form, setForm] = useState(makeProps(initial === undefined ? {} : { postMergeEvidence: initial }).form);
  return <>
    <MergeSection {...makeProps()} form={form} setForm={setForm} />
    <output data-testid="form-echo">{JSON.stringify({ postMergeEvidence: form.postMergeEvidence })}</output>
  </>;
}

function stubFetch(contract: unknown): void {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    json: async () => ({ contract }),
  })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MergeSection post-merge evidence reporter", () => {
  it("preselects Automatic for unset and null settings and hides the OneDev fields", () => {
    stubFetch(null);
    render(<ReporterHarness />);
    const select = screen.getByTestId("post-merge-evidence-provider") as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(screen.getByText("Automatic (derive from the repo)")).toBeInTheDocument();
    expect(screen.queryByText("Pipeline base URL")).not.toBeInTheDocument();
    expect(screen.queryByText("Token secret name")).not.toBeInTheDocument();
    // An unobservable board hides the status line rather than fabricating one.
    expect(screen.queryByTestId("post-merge-evidence-status")).not.toBeInTheDocument();
  });

  it("shows the status line from the fetched contract, rendering reason and presence-only facts", async () => {
    stubFetch({ provider: "onedev", reason: "onedev-endpoint", endpointHost: "onedev.example.test:6610", credentialConfigured: true });
    render(<ReporterHarness initial={{ provider: "onedev", baseUrl: "http://onedev.example.test:6610", tokenSecret: "ONEDEV_TOKEN" }} />);
    const status = await screen.findByTestId("post-merge-evidence-status");
    expect(status).toHaveTextContent("OneDev");
    expect(status).toHaveTextContent("derived: this repo's remote matches a configured OneDev endpoint");
    expect(status).toHaveTextContent("pipeline at onedev.example.test:6610");
    expect(status).toHaveTextContent("credential configured");
    // The OneDev-only fields appear for the onedev declaration with their stored values.
    expect(screen.getByLabelText("Pipeline base URL")).toHaveValue("http://onedev.example.test:6610");
    expect(screen.getByLabelText("Token secret name")).toHaveValue("ONEDEV_TOKEN");
  });

  it("hides the OneDev fields for a non-OneDev declaration", async () => {
    const user = userEvent.setup();
    stubFetch(null);
    render(<ReporterHarness />);
    await user.selectOptions(screen.getByTestId("post-merge-evidence-provider"), "github-actions");
    expect(screen.queryByLabelText("Pipeline base URL")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Token secret name")).not.toBeInTheDocument();
    // The note field is available for every declaration (it round-trips through note).
    expect(screen.getByLabelText("Note")).toBeInTheDocument();
    expect(screen.getByTestId("form-echo")).toHaveTextContent('{"postMergeEvidence":{"provider":"github-actions"}}');
  });

  it("strips the OneDev endpoint fields when the provider changes away from onedev, keeping the note", async () => {
    const user = userEvent.setup();
    stubFetch(null);
    render(<ReporterHarness initial={{ provider: "onedev", baseUrl: "http://onedev.example.test:6610", tokenSecret: "ONEDEV_TOKEN", note: "self-hosted CI" }} />);
    expect(screen.getByLabelText("Pipeline base URL")).toHaveValue("http://onedev.example.test:6610");
    await user.selectOptions(screen.getByTestId("post-merge-evidence-provider"), "gitlab");
    expect(screen.getByTestId("form-echo")).toHaveTextContent('{"postMergeEvidence":{"provider":"gitlab","note":"self-hosted CI"}}');
    expect(screen.queryByLabelText("Pipeline base URL")).not.toBeInTheDocument();
  });

  it("declares None as a real declaration {provider:'none'} and Automatic as null, keeping the note across provider changes", async () => {
    const user = userEvent.setup();
    stubFetch(null);
    render(<ReporterHarness initial={{ provider: "onedev", note: "board policy" }} />);
    await user.selectOptions(screen.getByTestId("post-merge-evidence-provider"), "none");
    expect(screen.getByTestId("form-echo")).toHaveTextContent('{"postMergeEvidence":{"provider":"none","note":"board policy"}}');
    await user.selectOptions(screen.getByTestId("post-merge-evidence-provider"), "");
    expect(screen.getByTestId("form-echo")).toHaveTextContent('{"postMergeEvidence":null}');
  });

  it("round-trips the note through the declaration object", async () => {
    const user = userEvent.setup();
    stubFetch(null);
    render(<ReporterHarness initial={{ provider: "gitlab" }} />);
    await user.type(screen.getByLabelText("Note"), "board policy");
    expect(screen.getByTestId("form-echo")).toHaveTextContent('{"provider":"gitlab","note":"board policy"}');
    await user.clear(screen.getByLabelText("Note"));
    expect(screen.getByTestId("form-echo")).toHaveTextContent('{"postMergeEvidence":{"provider":"gitlab"}}');
  });

  it("renders provider options from the core vocabulary (all four, Automatic first)", () => {
    stubFetch(null);
    render(<ReporterHarness />);
    const options = (screen.getByTestId("post-merge-evidence-provider") as HTMLSelectElement).options;
    expect([...options].map((o) => o.value)).toEqual(["", "github-actions", "onedev", "gitlab", "none"]);
  });

  it("carries the settings-search scroll anchor around the control it indexes", () => {
    stubFetch(null);
    render(<ReporterHarness />);
    // A search result scrolls via `[data-settings-key="<key>"]` (SettingsModal); an indexed key whose row
    // carries no anchor is the FN-8855 defect — the result renders and the jump does nothing.
    const anchor = document.querySelector('[data-settings-key="postMergeEvidence"]');
    expect(anchor).not.toBeNull();
    expect(anchor!.contains(screen.getByTestId("post-merge-evidence-provider"))).toBe(true);
  });

  it("waits for the contract fetch without crashing when the endpoint fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    render(<ReporterHarness />);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/post-merge-evidence"));
    expect(screen.queryByTestId("post-merge-evidence-status")).not.toBeInTheDocument();
  });
});
