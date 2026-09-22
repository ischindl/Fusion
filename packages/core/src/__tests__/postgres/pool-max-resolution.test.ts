import { describe, expect, it, vi } from "vitest";
import { resolvePoolMax } from "../../postgres/connection";

/*
FNXC:PostgresConnection 2026-09-22-16:12:
`FUSION_PG_POOL_MAX` is the operator escape hatch for a saturated 3-connection
store pool. Measured in production: the hold-release sweep on a 250-task project
held all 3 runtime connections in multi-second bursts and the dashboard health
probe (shared pool, 5s deadline) flapped /api/health to `degraded` on every
other poll. The knob must never silently accept garbage: an out-of-range value
on a small external-DB quota would overrun the server, so invalid inputs warn
and fall back to the conservative default of 3.
*/
describe("resolvePoolMax", () => {
  it("prefers an explicit per-call override over the environment", () => {
    expect(resolvePoolMax(1, { FUSION_PG_POOL_MAX: "12" }, vi.fn())).toBe(1);
  });

  it("reads FUSION_PG_POOL_MAX when no explicit cap is given", () => {
    expect(resolvePoolMax(undefined, { FUSION_PG_POOL_MAX: "12" }, vi.fn())).toBe(12);
  });

  it("keeps the small default when the variable is absent or blank", () => {
    expect(resolvePoolMax(undefined, {}, vi.fn())).toBe(3);
    expect(resolvePoolMax(undefined, { FUSION_PG_POOL_MAX: "  " }, vi.fn())).toBe(3);
  });

  it("warns and falls back to the default for non-integer or out-of-range values", () => {
    for (const raw of ["0", "-4", "501", "abc", "3.5"]) {
      const warn = vi.fn();
      expect(resolvePoolMax(undefined, { FUSION_PG_POOL_MAX: raw }, warn)).toBe(3);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(raw));
    }
  });
});
