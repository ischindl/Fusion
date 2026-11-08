import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EngineStatusBanner } from "../EngineStatusBanner";
import * as api from "../../api";

/*
 * FNXC:EngineStatusTruth 2026-11-07-13:55 (RUFU-496):
 * `t` resolves against the REAL English catalog instead of returning the call-site fallback. A
 * fallback-only mock cannot tell a wired key from a missing one: every new engineBanner key this task
 * adds (age, stage, other-process, paused, resume) would have rendered its hardcoded default and the
 * suite would stay green while the shipped copy stayed unreachable.
 */
vi.mock("react-i18next", async () => {
  /*
   * FNXC:DashboardTests 2026-11-07-15:40 (RUFU-496):
   * The catalog is read through the sanctioned module-relative fixture helper. A `process.cwd()`-anchored
   * read crashes a root-launched Vitest run at import time, which
   * `scripts/check-no-cwd-relative-dashboard-test-reads.mjs` rejects as a merge gate. The helper is
   * imported INSIDE the factory because a `vi.mock` factory cannot close over module scope.
   */
  const { readAppFile } = await import("../../test/cssFixture");
  const catalog = JSON.parse(readAppFile("../../i18n/locales/en/app.json")) as Record<string, unknown>;

  const lookup = (key: string): string | undefined => {
    // The loaded file IS the `app` namespace, so the dotted key walks it from its top level.
    const path = key.split(".");
    let node: unknown = catalog;
    for (const segment of path) {
      if (typeof node !== "object" || node === null) return undefined;
      node = (node as Record<string, unknown>)[segment];
    }
    return typeof node === "string" ? node : undefined;
  };

  return {
    useTranslation: () => ({
      t: (key: string, fallback?: string, values?: Record<string, string>) => {
        let text = lookup(key) ?? fallback ?? key;
        if (values) {
          for (const [name, value] of Object.entries(values)) {
            text = text.replace(`{{${name}}}`, value);
          }
        }
        return text;
      },
    }),
  };
});

vi.mock("../../api", () => ({
  fetchEngineStatus: vi.fn(),
  startEngine: vi.fn(),
}));

const mockFetchEngineStatus = vi.mocked(api.fetchEngineStatus);
const mockStartEngine = vi.mocked(api.startEngine);

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("EngineStatusBanner", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetchEngineStatus.mockReset();
    mockStartEngine.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders no banner, button, or aria-live shell when the engine is connected", async () => {
    mockFetchEngineStatus.mockResolvedValueOnce({ connected: true, starting: false, canStart: false, engineHandle: true, projectId: "project-a" });

    const { queryByTestId, container } = render(<EngineStatusBanner projectId="project-a" />);
    await act(async () => {
      await flushPromises();
    });

    expect(queryByTestId("engine-status-banner")).toBeNull();
    expect(queryByTestId("engine-status-start-button")).toBeNull();
    expect(container.querySelector('[aria-live="polite"]')).toBeNull();
  });

  it("shows an enabled Start engine button when disconnected and startable", async () => {
    mockFetchEngineStatus.mockResolvedValueOnce({ connected: false, starting: false, canStart: true, projectId: "project-a" });

    render(<EngineStatusBanner projectId="project-a" />);

    expect(await screen.findByTestId("engine-status-banner")).toBeInTheDocument();
    const button = screen.getByTestId("engine-status-start-button");
    expect(button).toBeEnabled();
    expect(button).toHaveTextContent("Start engine");
    expect(screen.getByText("Project engine is not connected")).toBeInTheDocument();
  });

  it("clicking Start engine calls startEngine and refetches status", async () => {
    mockFetchEngineStatus
      .mockResolvedValueOnce({ connected: false, starting: false, canStart: true, projectId: "project-a" })
      .mockResolvedValueOnce({ connected: true, starting: false, canStart: false, engineHandle: true, projectId: "project-a" });
    mockStartEngine.mockResolvedValueOnce({ connected: false, starting: true, canStart: false, reason: "starting", projectId: "project-a" });

    const { queryByTestId, container } = render(<EngineStatusBanner projectId="project-a" />);
    const button = await screen.findByTestId("engine-status-start-button");

    await act(async () => {
      fireEvent.click(button);
      await flushPromises();
    });

    expect(mockStartEngine).toHaveBeenCalledWith("project-a");
    expect(mockFetchEngineStatus).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(queryByTestId("engine-status-banner")).toBeNull());
    expect(queryByTestId("engine-status-start-button")).toBeNull();
    expect(container.querySelector('[aria-live="polite"]')).toBeNull();
  });

  /*
   * FNXC:EngineStatusTruth 2026-11-07-13:55 (RUFU-496):
   * This case used to be fed `{connected:false, starting:true, canStart:true}` - the contradictory
   * triple this task removes. The server now withholds `canStart` for the duration of an attempt, so
   * the fixture states the new truth: the button survives as a disabled progress indicator, and the
   * body names the attempt instead of offering an action.
   */
  it("keeps the Start button as a disabled progress indicator while a tracked attempt is in flight", async () => {
    mockFetchEngineStatus.mockResolvedValueOnce({
      connected: false,
      starting: true,
      canStart: false,
      reason: "starting",
      startingAgeMs: 4_000,
      startingStage: "runtime-start",
      projectId: "project-a",
    });

    render(<EngineStatusBanner projectId="project-a" />);

    const button = await screen.findByTestId("engine-status-start-button");
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("Starting…");
  });

  it("names the age and the awaited stage once a start attempt has been running for minutes", async () => {
    mockFetchEngineStatus.mockResolvedValueOnce({
      connected: false,
      starting: true,
      canStart: false,
      reason: "starting",
      startingAgeMs: 135_000,
      startingStage: "singleton-acquire",
      projectId: "project-a",
    });

    render(<EngineStatusBanner projectId="project-a" />);

    const body = await screen.findByTestId("engine-status-banner");
    expect(body).toHaveTextContent("Starting for 2m 15s");
    expect(body).toHaveTextContent("waiting for the engine lock held by another process");
  });

  /*
   * FNXC:EngineStatusTruth 2026-11-07-13:55 (RUFU-496):
   * The reported symptom, rendered: another process owns the engine and the project's lanes are
   * running, so the panel must not claim an outage or offer to start anything.
   */
  it("renders nothing when the project is connected through lanes running in another process", async () => {
    mockFetchEngineStatus.mockResolvedValueOnce({
      connected: true,
      starting: false,
      canStart: false,
      reason: "live-without-handle",
      engineHandle: false,
      runningAgentCount: 2,
      projectId: "project-a",
    });

    const { queryByTestId, container } = render(<EngineStatusBanner projectId="project-a" />);
    await act(async () => {
      await flushPromises();
    });

    expect(queryByTestId("engine-status-banner")).toBeNull();
    expect(queryByTestId("engine-status-start-button")).toBeNull();
    expect(container.querySelector('[aria-live="polite"]')).toBeNull();
  });

  it("names the other process and offers no start when another process owns the engine", async () => {
    mockFetchEngineStatus.mockResolvedValueOnce({
      connected: true,
      starting: false,
      canStart: false,
      reason: "externally-owned",
      externallyOwned: true,
      projectId: "project-a",
    });

    // connected is true for external ownership, so the banner is hidden by the same rule.
    const { queryByTestId } = render(<EngineStatusBanner projectId="project-a" />);
    await act(async () => {
      await flushPromises();
    });
    expect(queryByTestId("engine-status-start-button")).toBeNull();

    // Rendered against a payload where the liveness signal has not landed yet, the copy still names
    // the owner rather than an outage.
    mockFetchEngineStatus.mockResolvedValueOnce({
      connected: false,
      starting: false,
      canStart: false,
      reason: "externally-owned",
      externallyOwned: true,
      projectId: "project-a",
    });
    const { getByTestId } = render(<EngineStatusBanner projectId="project-a" />);
    await act(async () => {
      await flushPromises();
    });
    expect(getByTestId("engine-status-banner")).toHaveTextContent("Another fusion process is running");
    expect(queryByTestId("engine-status-start-button")).toBeNull();
  });

  it("offers Resume rather than Start for a deliberately paused project", async () => {
    mockFetchEngineStatus.mockResolvedValueOnce({
      connected: false,
      starting: false,
      canStart: false,
      canResume: true,
      reason: "paused",
      projectId: "project-a",
    });

    render(<EngineStatusBanner projectId="project-a" />);

    const button = await screen.findByTestId("engine-status-start-button");
    expect(button).toHaveTextContent("Resume engine");
    expect(button).toBeEnabled();
    expect(screen.getByTestId("engine-status-banner")).toHaveTextContent("This project is paused");
  });

  it("names the recorded reason when the last start failed", async () => {
    mockFetchEngineStatus.mockResolvedValueOnce({
      connected: false,
      starting: false,
      canStart: true,
      reason: "start-failed",
      lastStartFailure: {
        at: new Date(Date.now() - 45_000).toISOString(),
        stage: "runtime-start",
        message: "Engine start did not settle within its deadline",
        timedOut: true,
      },
      projectId: "project-a",
    });

    render(<EngineStatusBanner projectId="project-a" />);

    const banner = await screen.findByTestId("engine-status-banner");
    expect(banner).toHaveTextContent("Last start failed");
    expect(banner).toHaveTextContent("did not settle within its deadline");
    expect(screen.getByTestId("engine-status-start-button")).toBeEnabled();
  });

  /*
   * The one rule the panel must never break: it cannot show a Start action the server says is
   * impossible. Enumerated rather than trusted to the branch wording.
   */
  const notStartable: Array<[string, Record<string, unknown>]> = [
    ["externally-owned", { reason: "externally-owned", externallyOwned: true }],
    ["no-project", { reason: "no-project" }],
    ["attempt in flight", { reason: "starting", starting: true, startingAgeMs: 1_000, startingStage: "runtime-start" }],
  ];

  for (const [name, fields] of notStartable) {
    it(`never renders an enabled Start action when the server withholds it (${name})`, async () => {
      mockFetchEngineStatus.mockResolvedValueOnce({
        connected: false,
        starting: false,
        canStart: false,
        projectId: "project-a",
        ...fields,
      });

      render(<EngineStatusBanner projectId="project-a" />);
      await act(async () => {
        await flushPromises();
      });

      const button = screen.queryByTestId("engine-status-start-button");
      if (button) expect(button).toBeDisabled();
    });
  }

  it("shows dashboard-only guidance with no start button when the server cannot start engines", async () => {
    mockFetchEngineStatus.mockResolvedValueOnce({ connected: false, starting: false, canStart: false, reason: "dashboard-only", projectId: "project-a" });

    render(<EngineStatusBanner projectId="project-a" />);

    expect(await screen.findByTestId("engine-status-banner")).toBeInTheDocument();
    expect(screen.queryByTestId("engine-status-start-button")).toBeNull();
    expect(screen.getByText("fn serve")).toBeInTheDocument();
  });

  it("treats unreachable status probes as disconnected guidance without an enabled action", async () => {
    mockFetchEngineStatus.mockRejectedValueOnce(new Error("offline"));

    render(<EngineStatusBanner projectId="project-a" />);

    expect(await screen.findByTestId("engine-status-banner")).toBeInTheDocument();
    expect(screen.queryByTestId("engine-status-start-button")).toBeNull();
    expect(screen.getByText("fn serve")).toBeInTheDocument();
  });

  it("renders retryable start errors inline", async () => {
    mockFetchEngineStatus.mockResolvedValueOnce({ connected: false, starting: false, canStart: true, projectId: "project-a" });
    mockStartEngine.mockRejectedValueOnce(new Error("engine failed"));

    render(<EngineStatusBanner projectId="project-a" />);
    const button = await screen.findByTestId("engine-status-start-button");

    await act(async () => {
      fireEvent.click(button);
      await flushPromises();
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Start failed: engine failed");
    expect(screen.getByTestId("engine-status-start-button")).toBeEnabled();
  });

  it("ships responsive mobile scaffolding for the banner stack", () => {
    const css = readFileSync(resolve(__dirname, "..", "EngineStatusBanner.css"), "utf8");

    expect(css).toContain("@media (max-width: 768px)");
    expect(css).toContain(".engine-status-banner__start");
    expect(css).toContain("width: 100%");
  });
});
