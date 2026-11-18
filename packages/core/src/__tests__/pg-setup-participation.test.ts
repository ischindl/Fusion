import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  collectPgTimeoutBoundaryObserverEnv,
  resolvePgSetupParticipation,
  runPgSetupPreflight,
} from "../__test-utils__/pg-setup-participation.js";

describe("PostgreSQL setup participation", () => {
  it.each([undefined, "", " ", "0", "true", "1 "])("keeps %j non-participating", (value) => {
    expect(resolvePgSetupParticipation(value === undefined ? {} : { FUSION_PG_TEST_SETUP_PARTICIPANT: value })).toEqual({ participating: false, reason: "not-opted-in" });
  });

  it("accepts only the explicit participant value and honors skip", () => {
    expect(resolvePgSetupParticipation({ FUSION_PG_TEST_SETUP_PARTICIPANT: "1" })).toEqual({ participating: true, reason: "enabled" });
    expect(resolvePgSetupParticipation({ FUSION_PG_TEST_SETUP_PARTICIPANT: "1", FUSION_PG_TEST_SKIP: "1", FUSION_PG_TEST_PREADMISSION_PROBE: "1" })).toEqual({ participating: false, reason: "skip-requested" });
  });

  it("prebuilds only for the explicitly participating PostgreSQL lane", async () => {
    let prebuilds = 0;
    const prebuild = async () => {
      prebuilds += 1;
    };

    await expect(runPgSetupPreflight(prebuild, {})).resolves.toEqual({
      participating: false,
      reason: "not-opted-in",
    });
    await expect(runPgSetupPreflight(prebuild, { FUSION_PG_TEST_SKIP: "1" })).resolves.toEqual({
      participating: false,
      reason: "skip-requested",
    });
    expect(prebuilds).toBe(0);

    await expect(runPgSetupPreflight(prebuild, { FUSION_PG_TEST_SETUP_PARTICIPANT: "1" })).resolves.toEqual({
      participating: true,
      reason: "enabled",
    });
    expect(prebuilds).toBe(1);
  });

  /*
  FNXC:PgCredentialRefusal 2026-11-18-05:33 (RUFU-724):
  FN-9563 moved golden-template construction into participating global setup, so a
  credential refusal (SQLSTATE 28P01, classified by pg-provisioning-diagnostics.ts)
  is a setup-boundary failure: it must reach global setup and fail the lane loudly,
  never be swallowed into a silent pass. RUFU-517's probe skip applies to a provably
  refused PASSWORDLESS URL before any connect attempt; once the harness really dials
  (notably the credential-bearing CI-parity shape whose secret is wrong), the refusal
  raises and the participating preflight must propagate it. The same failing callback
  must never be invoked for a non-participating lane - that keeps every other Vitest
  lane connectionless.
  */
  it("rethrows the decorated credential refusal raised by the participating prebuild", async () => {
    const refusal = Object.assign(
      new Error(
        'password authentication failed for user "schindler" PostgreSQL refused the login credential for role "schindler" (SQLSTATE class 28, invalid authorization).',
      ),
      { code: "28P01" },
    );
    await expect(
      runPgSetupPreflight(async () => {
        throw refusal;
      }, { FUSION_PG_TEST_SETUP_PARTICIPANT: "1" }),
    ).rejects.toBe(refusal);

    let invocations = 0;
    const failingPrebuild = async () => {
      invocations += 1;
      throw refusal;
    };
    await expect(runPgSetupPreflight(failingPrebuild, {})).resolves.toEqual({
      participating: false,
      reason: "not-opted-in",
    });
    await expect(runPgSetupPreflight(failingPrebuild, { FUSION_PG_TEST_SKIP: "1" })).resolves.toEqual({
      participating: false,
      reason: "skip-requested",
    });
    expect(invocations).toBe(0);
  });

  it("forwards only observer controls into forked PostgreSQL canary workers", () => {
    expect(collectPgTimeoutBoundaryObserverEnv({
      FUSION_PG_TEST_TIMEOUT_BOUNDARY_OBSERVER: "1",
      FUSION_PG_TEST_TIMEOUT_BOUNDARY_OBSERVER_LOG: "/safe/evidence.jsonl",
      FUSION_PG_TEST_TIMEOUT_BOUNDARY_OBSERVER_WATCHDOG_MS: "12000",
      DATABASE_URL: "postgresql://secret@example.test/fusion",
      FUSION_PG_TEST_SETUP_PARTICIPANT: "1",
      OTHER_FLAG: "kept-out",
    })).toEqual({
      FUSION_PG_TEST_TIMEOUT_BOUNDARY_OBSERVER: "1",
      FUSION_PG_TEST_TIMEOUT_BOUNDARY_OBSERVER_LOG: "/safe/evidence.jsonl",
      FUSION_PG_TEST_TIMEOUT_BOUNDARY_OBSERVER_WATCHDOG_MS: "12000",
    });
  });

  it("has no PostgreSQL or harness dependency", () => {
    const source = readFileSync(new URL("../__test-utils__/pg-setup-participation.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/postgres|pg-test-harness|node:net|node:fs/);
    expect(source).not.toMatch(/process\.env\s*\[[^\]]+\]\s*=/);
  });
});
