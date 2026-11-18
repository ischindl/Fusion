import { userInfo } from "node:os";

/*
FNXC:PgTestProvisioning 2026-08-22-16:55:
A TCP-open PostgreSQL listener can still reject the harness identity or lack PL/pgSQL.
Keep the remediation at the raising seams so failed test setup names the local provisioning command.
*/

/**
 * Resolve the login role the harness presents, mirroring the precedence
 * documented in docs/testing.md and implemented by postgres@3.4.9:
 * URL username, then `PGUSERNAME`, then `PGUSER`, then the OS user.
 *
 * FNXC:PgCredentialRefusal 2026-11-18-05:33 (RUFU-724):
 * Env vars are consulted BEFORE the `userInfo()` syscall (same sandbox-safe shape
 * as `defaultProbeUser` in pg-startup-probe.ts) so the refused role is nameable and
 * injectable in tests without touching the host. The driver reaches `userInfo()`
 * only when no env names a role, which is exactly when this helper does too.
 * Never returns a password or any URL userinfo secret.
 */
function resolvedLoginRole(urlBase: string, env: NodeJS.ProcessEnv): string {
  try {
    const parsed = new URL(urlBase);
    if (parsed.username) return decodeURIComponent(parsed.username);
  } catch {
    // A malformed or path-less base URL names no role; fall through to env/OS.
  }
  const envRole = env.PGUSERNAME || env.PGUSER || env.USERNAME || env.USER || env.LOGNAME;
  if (envRole) return envRole;
  try {
    return userInfo().username;
  } catch {
    return "postgres";
  }
}

export function decoratePgProvisioningError(
  error: unknown,
  urlBase: string,
  env: NodeJS.ProcessEnv = process.env,
): unknown {
  if (!(error instanceof Error)) return error;

  const code = (error as Error & { code?: string }).code;
  const message = error.message;
  let remediation: string | undefined;
  if (code === "58P01" && message.includes("$libdir/plpgsql")) {
    remediation = " PostgreSQL cannot load PL/pgSQL. Run pnpm pg:test:up -- --replace to replace a broken local test server.";
  } else if (code === "28000" && /role\s+["'][^"']+["']\s+does not exist/i.test(message)) {
    // Role-absent keeps precedence over the credential class: it names a missing
    // role, not a refused secret, and its remedy is provisioning, not credentials.
    remediation = " PostgreSQL is reachable but lacks the configured login role. Run pnpm pg:test:up.";
  } else if (
    code === "28P01" ||
    (code === "28000" &&
      /(password authentication failed|no password supplied|invalid authorization specification)/i.test(message))
  ) {
    /*
    FNXC:PgCredentialRefusal 2026-11-18-05:33 (RUFU-724):
    Since FN-9563 built the golden template in participating global setup, a
    credential refusal is not just another mid-suite failure - the whole pg-gate
    lane cannot boot. RUFU-517 gave the launch probe a refusal detector, so a
    provably-refused PASSWORDLESS URL now skips with a warning; but any refusal
    that still surfaces as a driver error - above all the credential-bearing
    shape where the probe stays indeterminate and the harness really connects
    (CI's URL form with a wrong secret) - surfaced as a raw SQLSTATE 28P01 stack
    inside `SELECT pg_advisory_lock(...)`, naming neither the missing credential
    nor the fix. SQLSTATE class 28 (28P01 invalid_password; 28000 when the
    message itself is the password/authorization refusal) is therefore named at
    the raising seam with the resolved role and BOTH sanctioned remedies: the
    local test server, or a credential-bearing target (CI parity: the gate job's
    service container in .github/workflows/pr-checks.yml). The driver's own
    message is credential-free and only the role is interpolated here, so the
    decorated text never echoes a password or URL userinfo secret.
    */
    const role = resolvedLoginRole(urlBase, env);
    remediation =
      ` PostgreSQL refused the login credential for role "${role}" (SQLSTATE class 28, invalid authorization). ` +
      "Start the sanctioned local test server (pnpm pg:test:up; inspect with pnpm pg:test:status, stop with pnpm pg:test:down), " +
      "or point the harness at a credential-bearing target: export FUSION_PG_TEST_URL_BASE naming a user and supply its secret " +
      "via PGPASSWORD or URL userinfo. See docs/testing.md (Local PostgreSQL test server provisioning) and the gate job's " +
      "postgres service in .github/workflows/pr-checks.yml for the CI-parity wiring.";
  } else if (code === "3D000" && /database\s+["'][^"']+["']\s+does not exist/i.test(message)) {
    remediation = " PostgreSQL lacks the configured database. Run pnpm pg:test:up; postgres@3.4.9 resolves the database from the URL path, then PGDATABASE, then the role name.";
  } else if (code === "ECONNREFUSED" || /ECONNREFUSED/.test(message)) {
    remediation = " PostgreSQL refused the connection. Run pnpm pg:test:up.";
  }
  if (!remediation) return error;
  const decorated = new Error(`${message}${remediation}`);
  Object.assign(decorated, error);
  return decorated;
}
