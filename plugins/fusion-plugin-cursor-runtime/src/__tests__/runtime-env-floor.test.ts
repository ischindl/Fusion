import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { launchCursorPrompt } from "../prompt-transport.js";

function fakeSupervisor() {
  const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; exitCode: number | null; signalCode: NodeJS.Signals | null };
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.signalCode = null;
  const supervise = vi.fn((..._args: unknown[]) => ({ child, pid: 44, pgid: 44, kill: vi.fn(), waitExit: async () => ({ code: 0, signal: null }) }));
  return { child, supervise };
}

/*
FNXC:NonInteractiveGit 2026-09-11-22:40 (RUFU-210):
The Cursor prompt-transport spawn previously carried no `env` field at all — the child inherited
`process.env` verbatim. The operator-selected runtime lane now gets the scoped non-interactive git
floor (a `git commit -e` left in the child env blocks forever: measured 1d13h orphan, 2026-09-09).
*/
describe("launchCursorPrompt non-interactive git floor", () => {
  it("passes a scoped env carrying the git floor to the supervised spawn", async () => {
    const { child, supervise } = fakeSupervisor();
    const promise = launchCursorPrompt({ cwd: "/tmp", prompt: "hello" }, { supervise: supervise as never, platform: "darwin" });
    const options = supervise.mock.calls[0]![2] as { env?: NodeJS.ProcessEnv };
    expect(options.env).toEqual(
      expect.objectContaining({
        GIT_EDITOR: "true",
        GIT_SEQUENCE_EDITOR: "true",
        GIT_PAGER: "cat",
        GIT_TERMINAL_PROMPT: "0",
        GIT_MERGE_AUTOEDIT: "no",
      }),
    );
    child.stdout.write('{"type":"result","is_error":false}\n');
    child.emit("close", 0);
    await promise;
  });
});
