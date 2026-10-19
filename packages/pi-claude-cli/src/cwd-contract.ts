/**
 * Working-directory contract for the Claude runtime lane.
 *
 * FNXC:AgentCwdBoundary 2026-10-18-10:29:
 * RUFU-334. Both Claude transports used to end their cwd chain with
 * `?? process.cwd()`. This extension is loaded *inside* the engine/dashboard
 * process, so that value is the directory the server was launched from — never
 * the session's checkout. On the incident host the serve root was a production
 * deployment checkout, so a Claude turn (and the Usage probe, which shared the
 * same shape) spawned a write-capable `claude` in the deployed tree with no
 * attribution. A working directory is therefore a caller obligation, not a
 * defaultable option, and the refusal has to name the lane that forgot it.
 *
 * This rule is package-local on purpose. `@fusion/core` owns the sibling rule
 * (`assertAgentCwdAllowed`, which additionally refuses operator-declared
 * protected checkouts) and is enforced at the session seam that starts the lane;
 * this package is a standalone pi extension and must keep zero `@fusion/*`
 * imports, so it cannot reach that module.
 */

import { isAbsolute } from "node:path";

/** Thrown when a Claude-runtime lane is entered without a working directory. */
export class MissingAgentCwdError extends Error {
  constructor(lane: string, detail?: string) {
    super(
      `pi-claude-cli: "${lane}" requires an explicit working directory. The caller must pass ` +
        `an absolute checkout path; it is never defaulted to the process directory, because in a ` +
        `hosted engine process that is the server's launch directory rather than the session's ` +
        `checkout.` + (detail ? ` (${detail})` : ""),
    );
    this.name = "MissingAgentCwdError";
  }
}

/**
 * Validate a lane's caller-supplied cwd and return it unchanged.
 *
 * The value is returned verbatim (no `resolve`, no `normalize`) because
 * `acp-driver.ts` reuses a warm bridge connection only while `warm.cwd === cwd`;
 * normalising here would make a warm entry unreachable while the caller still
 * believes it passed the same path.
 *
 * @param cwd - the caller's working directory, expected absolute
 * @param lane - transport name to blame in the message (`streamViaCli`, `streamViaAcp`, `spawnClaude`)
 */
export function resolveRequiredCwd(cwd: string | undefined, lane: string): string {
  if (typeof cwd !== "string" || cwd.trim() === "") {
    throw new MissingAgentCwdError(lane, "received " + (cwd === undefined ? "undefined" : JSON.stringify(cwd)));
  }
  // A relative cwd would be resolved by `spawn` against the process directory,
  // which is exactly the inheritance this contract removes.
  if (!isAbsolute(cwd)) {
    throw new MissingAgentCwdError(lane, `${JSON.stringify(cwd)} is not an absolute path`);
  }
  return cwd;
}
