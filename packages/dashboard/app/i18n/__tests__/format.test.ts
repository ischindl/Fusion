import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ lng: "en" }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { resolvedLanguage: state.lng, language: state.lng },
    t: (k: string, d?: string) => d ?? k,
  }),
}));

const { useLocaleFormat } = await import("../format");

describe("useLocaleFormat", () => {
  it("formats numbers with the active locale's separators", () => {
    state.lng = "en";
    const en = renderHook(() => useLocaleFormat()).result.current.formatNumber(1234567);
    expect(en).toContain(",");

    state.lng = "fr";
    const fr = renderHook(() => useLocaleFormat()).result.current.formatNumber(1234567);
    expect(fr).not.toContain(",");
    expect(fr).not.toBe(en);
  });

  it("formats dates per active locale", () => {
    const date = new Date(Date.UTC(2026, 0, 15));
    state.lng = "en";
    const en = renderHook(() => useLocaleFormat()).result.current.formatDate(date, {
      month: "long",
      timeZone: "UTC",
    });
    state.lng = "fr";
    const fr = renderHook(() => useLocaleFormat()).result.current.formatDate(date, {
      month: "long",
      timeZone: "UTC",
    });
    expect(en).toMatch(/January/);
    expect(fr).toMatch(/janvier/);
  });

  it("exposes the resolved locale", () => {
    state.lng = "zh-CN";
    expect(renderHook(() => useLocaleFormat()).result.current.locale).toBe("zh-CN");
  });
});
