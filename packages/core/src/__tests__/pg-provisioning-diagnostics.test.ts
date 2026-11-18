import { describe, expect, it } from "vitest";
import { decoratePgProvisioningError } from "../__test-utils__/pg-provisioning-diagnostics.js";

function pgError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe("decoratePgProvisioningError", () => {
  it.each([
    [pgError("58P01", 'could not access file "$libdir/plpgsql"'), "pnpm pg:test:up -- --replace"],
    [pgError("28000", 'role "node" does not exist'), "pnpm pg:test:up"],
    [pgError("3D000", 'database "node" does not exist'), "role name"],
    [pgError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:5432"), "pnpm pg:test:up"],
  ])("decorates supported PostgreSQL failures", (error, expected) => {
    const decorated = decoratePgProvisioningError(error, "postgresql://localhost:5432");
    expect(decorated).toBeInstanceOf(Error);
    expect(decorated).not.toBe(error);
    expect((decorated as Error).message).toContain(error.message);
    expect((decorated as Error).message).toContain(expected);
  });

  it("preserves unrelated and non-Error throwables by identity", () => {
    const ordinary = new Error("ordinary failure");
    const nonError = { code: "28000" };
    const unrelatedPg = pgError("58P01", "some other library is missing");
    // A 28000 without a password/authorization refusal message is not the credential class.
    const otherAuth28000 = pgError("28000", "database connection failed in a weird way");
    expect(decoratePgProvisioningError(ordinary, "postgresql://localhost:5432")).toBe(ordinary);
    expect(decoratePgProvisioningError(nonError, "postgresql://localhost:5432")).toBe(nonError);
    expect(decoratePgProvisioningError(unrelatedPg, "postgresql://localhost:5432")).toBe(unrelatedPg);
    expect(decoratePgProvisioningError(otherAuth28000, "postgresql://localhost:5432", {})).toBe(otherAuth28000);
  });

  /*
  FNXC:PgCredentialRefusal 2026-11-18-05:33 (RUFU-724):
  FN-9563 made a usable login a hard prerequisite of the pg-gate lane (the golden
  template prebuild connects for real), and RUFU-517's probe only skips the
  provably-refused passwordless URL. The refusal that still raises - the
  credential-bearing shape CI uses with a wrong secret - must be named at the
  raising seam: SQLSTATE class 28, the resolved role, both sanctioned remedies,
  and never the secret. These fixtures pin the verbatim driver texts.
  */
  describe("credential refusal (SQLSTATE class 28)", () => {
    it("decorates 28P01 password authentication failed with the refused role and both remedies", () => {
      const error = pgError("28P01", 'password authentication failed for user "schindler"');
      const decorated = decoratePgProvisioningError(error, "postgresql://localhost:5432", {
        USER: "schindler",
      }) as Error & { code?: string };
      expect(decorated).toBeInstanceOf(Error);
      expect(decorated).not.toBe(error);
      expect(decorated.message).toContain('password authentication failed for user "schindler"');
      expect(decorated.message).toContain('role "schindler"');
      expect(decorated.message).toContain("SQLSTATE class 28");
      expect(decorated.message).toContain("pnpm pg:test:up");
      expect(decorated.message).toContain("FUSION_PG_TEST_URL_BASE");
      expect(decorated.message).toContain("docs/testing.md");
      expect(decorated.message).toContain(".github/workflows/pr-checks.yml");
      expect(decorated.code).toBe("28P01");
    });

    it("decorates 28P01 no password supplied (libpq client-side refusal)", () => {
      const error = pgError("28P01", "no password supplied");
      const decorated = decoratePgProvisioningError(error, "postgresql://localhost:5432", {
        USER: "schindler",
      }) as Error;
      expect(decorated).not.toBe(error);
      expect(decorated.message).toContain("no password supplied");
      expect(decorated.message).toContain("SQLSTATE class 28");
    });

    it("decorates a 28000 whose message is a password refusal without regressing role-absent", () => {
      const refused = pgError("28000", 'password authentication failed for user "fusionci"');
      const decorated = decoratePgProvisioningError(refused, "postgresql://localhost:5432", {}) as Error;
      expect(decorated).not.toBe(refused);
      expect(decorated.message).toContain("SQLSTATE class 28");
      // The role-absent branch keeps precedence for its own message and must not
      // grow the credential remediation text.
      const roleAbsent = pgError("28000", 'role "node" does not exist');
      const roleDecorated = decoratePgProvisioningError(roleAbsent, "postgresql://localhost:5432", {}) as Error;
      expect(roleDecorated.message).toContain("lacks the configured login role");
      expect(roleDecorated.message).not.toContain("SQLSTATE class 28");
    });

    it("names the URL role for a credential-bearing URL and never echoes its secret", () => {
      const error = pgError("28P01", 'password authentication failed for user "fusionci"');
      const decorated = decoratePgProvisioningError(
        error,
        "postgresql://fusionci:sup3r-sekr3t@localhost:5432",
        {},
      ) as Error;
      expect(decorated.message).toContain('role "fusionci"');
      expect(decorated.message).not.toContain("sup3r-sekr3t");
    });

    it("resolves the refused role by the documented precedence: URL username, PGUSERNAME, PGUSER, OS user", () => {
      const refused = pgError("28P01", "password authentication failed");
      const roleNamed = (url: string, env: Record<string, string>) =>
        (decoratePgProvisioningError(refused, url, env) as Error).message;
      expect(roleNamed("postgresql://urlrole@localhost:5432", { PGUSERNAME: "envrole", PGUSER: "other", USER: "osrole" })).toContain('role "urlrole"');
      expect(roleNamed("postgresql://localhost:5432", { PGUSERNAME: "pguserenv", PGUSER: "pguservar", USER: "osrole" })).toContain('role "pguserenv"');
      expect(roleNamed("postgresql://localhost:5432", { PGUSER: "pguservar", USER: "osrole" })).toContain('role "pguservar"');
      expect(roleNamed("postgresql://localhost:5432", { USER: "osrole" })).toContain('role "osrole"');
    });
  });
});
