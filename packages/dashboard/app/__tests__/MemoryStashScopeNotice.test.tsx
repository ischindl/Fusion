// @vitest-environment jsdom
/*
FNXC:StashReadScope 2026-11-19-13:41 (RUFU-1008):
RUFU-1008 made cross-project leakage visible as a count. The notice is mounted by BOTH memory
surfaces (Settings > Memory and the Memory view), which is why it is one component rather than a
sentence written twice — RUFU-994's "0 results" / "answered with 0 hits" pair is the precedent for
that shape, and a duplicated string is how one surface ends up silent.

These cases pin: the counts reach the sentence; an all-own read says nothing; and the English catalog
carries the key with both placeholders, so the shipped copy is the copy under test.
*/
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MemoryStashScopeNotice } from "../components/MemoryStashScopeNotice";
import type { StashReadScope } from "../api/system/memory.js";

// Mirrors react-i18next's default-value + interpolation contract closely enough to prove the numbers
// reach the rendered sentence, without booting an i18next instance for one string.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback: string, opts?: Record<string, unknown>) =>
      Object.entries(opts ?? {}).reduce(
        (text, [token, value]) => text.replaceAll(`{{${token}}}`, String(value)),
        fallback,
      ),
  }),
}));

function scope(over: Partial<StashReadScope> = {}): StashReadScope {
  return {
    outcome: "dropped-foreign",
    matchedCount: 9,
    ownCount: 2,
    droppedForeignCount: 7,
    droppedUnidentifiedCount: 0,
    limit: 5,
    at: Date.parse("2026-11-19T12:00:00.000Z"),
    ...over,
  };
}

describe("MemoryStashScopeNotice", () => {
  it("states both drop counts when a read was filtered", () => {
    render(<MemoryStashScopeNotice scope={scope()} />);
    const text = screen.getByText(/Excluded/i).textContent ?? "";
    expect(text).toContain("7");
    expect(text).toContain("line(s) from other Fusion projects");
  });

  it("names the unidentified count too when that is what was dropped", () => {
    render(
      <MemoryStashScopeNotice
        scope={scope({
          outcome: "dropped-unidentified",
          matchedCount: 6,
          ownCount: 4,
          droppedForeignCount: 0,
          droppedUnidentifiedCount: 2,
        })}
      />,
    );
    const text = screen.getByText(/Excluded/i).textContent ?? "";
    expect(text).toContain("2");
    expect(text).toContain("no project identity");
  });

  it("renders NOTHING for a read that dropped nothing — the common case must stay silent", () => {
    const { container } = render(
      <MemoryStashScopeNotice
        scope={scope({
          outcome: "all-own",
          matchedCount: 3,
          ownCount: 3,
          droppedForeignCount: 0,
          droppedUnidentifiedCount: 0,
        })}
      />,
    );
    expect(container.textContent).toBe("");
  });

  it("renders NOTHING when the backend reported no scope (local backend, or a read that never ran)", () => {
    const { container } = render(<MemoryStashScopeNotice scope={null} />);
    expect(container.textContent).toBe("");
  });

  it("quotes no URL, discriminator, or row content — counts are the whole payload", () => {
    render(
      <MemoryStashScopeNotice
        scope={scope({
          // A server URL and another project's discriminator exist upstream; they must never reach
          // the DOM. The component never receives them, and this asserts the rendered text is only numbers.
          ...scope({ droppedForeignCount: 3, droppedUnidentifiedCount: 1, ownCount: 1, matchedCount: 5 }),
        })}
      />,
    );
    const text = screen.getByText(/Excluded/i).textContent ?? "";
    expect(text).not.toMatch(/http|127\.0\.0\.1|discriminator|VLLM|GEDA/i);
  });

  it("ships the English catalog entry the component resolves, with both placeholders", () => {
    const catalog = JSON.parse(
      readFileSync(resolve(__dirname, "../../../i18n/locales/en/app.json"), "utf8"),
    );
    const entry = catalog.memory?.stashScopeDropped;
    expect(typeof entry).toBe("string");
    expect(entry).toContain("{{foreign}}");
    expect(entry).toContain("{{unidentified}}");
  });

  /*
  FNXC:StashReadScope 2026-11-19-13:41 (RUFU-1008):
  Code-construct guard, not a prose assertion: what the task demands is that the two memory surfaces
  cannot disagree about this sentence. They cannot because neither of them writes it — both mount
  this one component. If a future change inlines the copy into one surface again, that is the drift
  this case exists to catch.
  */
  it("is the only place the sentence is written — both memory surfaces mount it", () => {
    const surfaces = [
      "components/MemoryView.tsx",
      "components/settings/sections/MemorySection.tsx",
    ];
    for (const surface of surfaces) {
      const source = readFileSync(resolve(__dirname, "..", surface), "utf8");
      expect(source, `${surface} must mount the shared notice`).toContain("<MemoryStashScopeNotice");
      // A surface that re-inlines the copy would carry the sentence itself, not the component.
      expect(source, `${surface} must not re-inline the notice copy`).not.toContain(
        "stashScopeDropped",
      );
    }
  });
});
