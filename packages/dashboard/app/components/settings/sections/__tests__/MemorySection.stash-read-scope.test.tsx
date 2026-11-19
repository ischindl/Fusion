// @vitest-environment jsdom
/*
FNXC:StashReadScope 2026-11-19-16:08 (RUFU-1008):
What the operator SEES on the Settings > Memory surface when a Stash read is filtered. The wording
lives in the shared `MemoryStashScopeNotice`; what these cases prove is the MOUNT — the notice is
actually rendered inside the retrieval-result block, shows the counts, and stays out of the way when
nothing was dropped. The mount is the requirement: a shared component nothing mounts would pass every
component test while the operator still saw "0 results" for an answer the server had given.

Only the count is asserted to exist. No case here can assert a dropped line, because the payload is
counts and a class — and keeping it that way is the privacy contract.
*/
import { cleanup, render, screen } from "@testing-library/react";
import * as jestDomMatchers from "@testing-library/jest-dom/matchers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemorySection } from "../MemorySection";
import type { MemorySectionMemoryProps } from "../MemorySection";
import type { SettingsFormState } from "../context";
import type { MemoryRetrievalTestResult } from "../../../../api/system/memory.js";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, def?: unknown, opts?: Record<string, unknown>) => {
      if (typeof def !== "string") return key;
      return def.replace(/\{\{(\w+)\}\}/g, (_m: string, k: string) => String(opts?.[k] ?? ""));
    },
  }),
}));

expect.extend(jestDomMatchers);

afterEach(() => cleanup());

const memoryProps: MemorySectionMemoryProps = {
  memoryCapabilities: null,
  memoryBackendStatus: null,
  memoryBackendLoading: false,
  memoryBackendError: null,
  memoryFiles: [],
  selectedMemoryPath: "",
  setSelectedMemoryPath: vi.fn(),
  memoryContent: "",
  setMemoryContent: vi.fn(),
  memoryLoading: false,
  memoryDirty: false,
  setMemoryDirty: vi.fn(),
  memoryTestQuery: "geda",
  setMemoryTestQuery: vi.fn(),
  memoryTestLoading: false,
  memoryTestResult: null,
  qmdInstallLoading: false,
  dreamRunning: false,
  memoryCompactLoading: false,
  onInstallQmd: vi.fn(),
  onTestMemoryRetrieval: vi.fn(),
  onDreamNow: vi.fn(),
  onCompactMemory: vi.fn(),
  onSaveMemory: vi.fn(),
};

function resultWith(overrides: Partial<MemoryRetrievalTestResult> = {}): MemoryRetrievalTestResult {
  return {
    query: "geda",
    testedBackend: "stash",
    qmdAvailable: true,
    usedFallback: false,
    qmdInstallCommand: "",
    results: [],
    ...overrides,
  };
}

function renderWith(result: MemoryRetrievalTestResult | null) {
  const memory = { ...memoryProps, memoryTestResult: result };
  render(
    <MemorySection
      form={{ memoryEnabled: true } as SettingsFormState}
      setForm={vi.fn()}
      memory={memory}
    />,
  );
}

describe("MemorySection mounts the Stash read-scope notice (RUFU-1008)", () => {
  it("a filtered answer says so beside the result count, with the counts it names", () => {
    renderWith(resultWith({
      stashReadScope: {
        outcome: "dropped-foreign",
        ownCount: 0,
        droppedForeignCount: 2,
        droppedUnidentifiedCount: 1,
        matchedCount: 0,
        limit: 5,
        at: Date.parse("2026-11-19T12:00:00.000Z"),
      },
    }));
    // The sentence must land inside the retrieval-result block, not somewhere decorative.
    const block = document.querySelector(".memory-test-result");
    expect(block).toBeTruthy();
    expect(block!.textContent).toContain("Excluded 2 line(s) from other Fusion projects and 1 line(s) with no project identity.");
    // And the two truths stay separate: the count says 0 results, the notice says rows were dropped.
    expect(block!.textContent).toContain("0 result");
  });

  it("an all-own answer renders no notice", () => {
    renderWith(resultWith({
      results: [{ path: "x.md", lineStart: 1, lineEnd: 2, score: 1, snippet: "ours", backend: "stash" }],
      stashReadScope: {
        outcome: "all-own",
        ownCount: 1,
        droppedForeignCount: 0,
        droppedUnidentifiedCount: 0,
        matchedCount: 1,
        limit: 5,
        at: Date.now(),
      },
    }));
    expect(screen.queryByText(/Excluded/)).toBeNull();
    expect(document.querySelector(".memory-test-result")!.textContent).not.toContain("Excluded");
  });

  it("a pre-fix response with no scope field renders the old copy unchanged", () => {
    renderWith(resultWith());
    const block = document.querySelector(".memory-test-result")!;
    expect(block.textContent).toContain("No matching memory found.");
    expect(block.textContent).not.toContain("Excluded");
  });
});
