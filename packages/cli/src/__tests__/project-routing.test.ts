/*
FNXC:ProjectRoutingVisibility 2026-09-22-16:37:
Acceptance matrix for the pure routing decision behind `fn task create|duplicate|refine`.
The measured incident: cwd `/home/dev/git/Fusion` (registered `runfusion`), central default
`gedapp`, and `fn task create` printed only `Project: gedapp` plus a relative
`.fusion/tasks/RUFU-242/` path, so a card filed into another project looked local. Each case
below pins one branch of the documented precedence (flag → default → cwd): only the
DEFAULT-wins-and-the-cwd-belongs-to-a-different-project case may warn, because the flag case is
what the operator asked for, the cwd case derives from the cwd by definition, and the fallback
case has its own louder message.
*/
import { describe, it, expect } from "vitest";
import {
  cardDirectoryPath,
  crossProjectWarning,
  declinedCrossProjectNotice,
  evaluateProjectRouting,
  unregisteredCwdProjectWarning,
} from "../project-routing.js";

const RUNFUSION_CWD = { id: "proj_runfusion", name: "runfusion", path: "/home/dev/git/Fusion" };
const GEDAPP_PATH = "/home/dev/work/gedapp";

/** A resolved context: the central default picked `gedapp` while the cwd belongs to `runfusion`. */
function crossProjectDefault(overrides: Record<string, unknown> = {}) {
  return {
    projectName: "gedapp",
    projectPath: GEDAPP_PATH,
    resolvedFrom: "default" as const,
    cwdProject: RUNFUSION_CWD,
    cwd: "/home/dev/git/Fusion/cli",
    yes: false,
    isTty: false,
    ...overrides,
  };
}

describe("evaluateProjectRouting", () => {
  it("does not warn when --project chose the target, even across projects", () => {
    const decision = evaluateProjectRouting({
      projectName: "gedapp",
      projectPath: GEDAPP_PATH,
      resolvedFrom: "flag",
      cwdProject: RUNFUSION_CWD,
      cwd: "/home/dev/git/Fusion",
      yes: false,
      isTty: true,
    });

    expect(decision.warning).toBeUndefined();
    expect(decision.requiresConfirm).toBe(false);
    expect(decision.targetLine).toContain("Project: gedapp");
    expect(decision.targetLine).toContain(GEDAPP_PATH);
    expect(decision.targetLine).toContain("resolved via the --project flag");
  });

  it("warns and asks when the default project wins over a different cwd project", () => {
    const decision = evaluateProjectRouting(crossProjectDefault({ isTty: true }));

    expect(decision.requiresConfirm).toBe(true);
    expect(decision.warning).toContain("runfusion");
    expect(decision.warning).toContain("gedapp");
    expect(decision.warning).toContain(RUNFUSION_CWD.path);
    expect(decision.warning).toContain(GEDAPP_PATH);
    expect(decision.targetLine).toContain("resolved via the central default project");
  });

  it("--yes keeps the warning but removes the confirmation", () => {
    const decision = evaluateProjectRouting(crossProjectDefault({ isTty: true, yes: true }));

    expect(decision.warning).toBeDefined();
    expect(decision.requiresConfirm).toBe(false);
  });

  it("never asks for confirmation without a terminal", () => {
    const decision = evaluateProjectRouting(crossProjectDefault({ isTty: false }));

    expect(decision.warning).toBeDefined();
    expect(decision.requiresConfirm).toBe(false);
  });

  it("does not warn when the target was derived from the cwd itself", () => {
    const decision = evaluateProjectRouting({
      projectName: "runfusion",
      projectPath: RUNFUSION_CWD.path,
      resolvedFrom: "cwd",
      cwdProject: RUNFUSION_CWD,
      cwd: "/home/dev/git/Fusion/packages/cli",
      yes: false,
      isTty: true,
    });

    expect(decision.warning).toBeUndefined();
    expect(decision.requiresConfirm).toBe(false);
    expect(decision.targetLine).toContain("resolved via current-directory detection");
  });

  it("does not warn when the default project IS the cwd project", () => {
    const decision = evaluateProjectRouting({
      projectName: "runfusion",
      projectPath: RUNFUSION_CWD.path,
      resolvedFrom: "default",
      cwdProject: RUNFUSION_CWD,
      cwd: RUNFUSION_CWD.path,
      yes: false,
      isTty: true,
    });

    expect(decision.warning).toBeUndefined();
    expect(decision.requiresConfirm).toBe(false);
  });

  it.each([
    ["a trailing separator", "/home/dev/git/Fusion/"],
    ["an inner dot-segment", "/home/dev/git/./Fusion"],
    ["a detour through a parent", "/home/dev/git/other/../Fusion"],
  ])("treats the same folder spelled as %s as the target project itself", (_label, cwdPath) => {
    const decision = evaluateProjectRouting({
      projectName: "runfusion",
      projectPath: "/home/dev/git/Fusion",
      resolvedFrom: "default",
      cwdProject: { id: "p", name: "runfusion", path: cwdPath },
      cwd: cwdPath,
      yes: false,
      isTty: true,
    });

    expect(decision.warning).toBeUndefined();
    expect(decision.requiresConfirm).toBe(false);
  });

  it("leaves a hand-built context (no provenance) exactly as silent as before", () => {
    const decision = evaluateProjectRouting({
      projectName: "gedapp",
      projectPath: GEDAPP_PATH,
      cwd: "/home/dev/git/Fusion",
      yes: false,
      isTty: true,
    });

    expect(decision.warning).toBeUndefined();
    expect(decision.requiresConfirm).toBe(false);
    // Byte-identical to the pre-RUFU-269 line, so anything parsing it keeps working.
    expect(decision.targetLine).toBe("  Project: gedapp");
  });

  it("does not double-report the unregistered-cwd fallback", () => {
    const decision = evaluateProjectRouting({
      projectName: "fusion",
      projectPath: "/home/dev/git/fusion",
      resolvedFrom: "cwd-fallback",
      cwdProject: { id: "", name: "fusion", path: "/home/dev/git/fusion" },
      cwd: "/home/dev/git/fusion",
      yes: false,
      isTty: true,
    });

    // That path gets `unregisteredCwdProjectWarning`, which is specific; the generic one stays quiet.
    expect(decision.warning).toBeUndefined();
    expect(decision.requiresConfirm).toBe(false);
    expect(decision.targetLine).toContain("resolved via an unregistered local project");
  });
});

describe("routing message wording", () => {
  it("names both projects, both paths, and both remedies in the warning", () => {
    const warning = crossProjectWarning({
      projectName: "gedapp",
      projectPath: GEDAPP_PATH,
      resolvedFrom: "default",
      cwdProject: RUNFUSION_CWD,
      cwd: "/home/dev/git/Fusion",
      yes: false,
      isTty: false,
    });

    expect(warning).toContain("runfusion");
    expect(warning).toContain("gedapp");
    expect(warning).toContain("/home/dev/git/Fusion");
    expect(warning).toContain(GEDAPP_PATH);
    expect(warning).toContain("--project");
    expect(warning).toContain("fn project set-default");
  });

  it("names the target and the remedies when a declined create exits", () => {
    const notice = declinedCrossProjectNotice("gedapp");

    expect(notice).toContain("gedapp");
    expect(notice).toMatch(/not created/i);
    expect(notice).toContain("--project");
    expect(notice).toContain("fn project set-default");
  });

  it("states that the unregistered-cwd fallback is not a registered project", () => {
    const warning = unregisteredCwdProjectWarning("/home/dev/git/new-thing", "/home/dev/git/new-thing");

    expect(warning).toContain("/home/dev/git/new-thing");
    expect(warning).toContain(".fusion/");
    expect(warning).toContain("UNREGISTERED");
    expect(warning).toContain("fn project add");
  });
});

/*
FNXC:ProjectRoutingVisibility 2026-09-22-23:26 (RUFU-269): the printed card path was cwd-relative
(`Path: .fusion/tasks/RUFU-242/`), so a card filed into `gedapp` while the shell stood in `Fusion` printed a
path that did not exist where the operator was looking. `cardDirectoryPath` composes the path under the
TARGET project, which is the only statement that can be true.
*/
describe("cardDirectoryPath", () => {
  it("names the card directory under the target project, not the invocation cwd", () => {
    expect(cardDirectoryPath(GEDAPP_PATH, "FN-042")).toBe(`${GEDAPP_PATH}/.fusion/tasks/FN-042/`);
  });

  it("is absolute for every project path it is given", () => {
    const printed = cardDirectoryPath("/srv/projects/alpha", "RUFU-269");

    expect(printed.startsWith("/")).toBe(true);
    expect(printed).toContain("/srv/projects/alpha/");
  });
});

/*
FNXC:ProjectRoutingVisibility 2026-09-22-23:26 (RUFU-269): `--yes` is a flag, not the description. Before
this change `fn task create --project other "text" --yes` filed a card whose title literally ended in
"--yes", because the flag was never consumed and the leftover became the positional description. These
cases guard the parse half of that fix and pin that `--yes` answers ONLY the routing confirm — it must not
quietly grow into a bypass of the duplicate guards.
*/
describe("fn task create argument parsing", () => {
  /** Load the CLI parser without letting `bin.ts` run `main()` on import. */
  const loadParser = async () => {
    process.env.FUSION_CLI_SKIP_MAIN = "1";
    const mod = await import("../bin.js");
    return mod.parseTaskCreateArgs;
  };

  it("keeps --yes out of the card title", async () => {
    const parse = await loadParser();
    const args = parse(["ship the router fix", "--yes"]);

    expect(args.title).toBe("ship the router fix");
    expect(args.title).not.toContain("--yes");
    expect(args.yes).toBe(true);
  });

  it("records --yes wherever it sits in the argument order", async () => {
    const parse = await loadParser();

    expect(parse(["--yes", "text"]).yes).toBe(true);
    expect(parse(["--yes", "text"]).title).toBe("text");
    expect(parse(["text"]).yes).toBe(false);
  });

  it("leaves the duplicate guards on: --yes answers the routing confirm only", async () => {
    const parse = await loadParser();

    expect(parse(["text", "--yes"]).noDedup).toBe(false);
  });

  it("keeps every pre-existing flag parsing as it was", async () => {
    const parse = await loadParser();
    const args = parse(["--no-dedup", "--depends", "FN-1,FN-2", "--attach", "a.png", "--node", "Platform", "desc"]);

    expect(args).toMatchObject({
      title: "desc",
      nodeName: "Platform",
      noDedup: true,
      // Pre-existing contract: each `--depends` value is kept verbatim; comma-splitting happens downstream.
      depends: ["FN-1,FN-2"],
      yes: false,
    });
    expect(args.attachFiles).toEqual(["a.png"]);
  });

  /*
  FNXC:TaskTitleHygiene 2026-09-26-02:28 (RUFU-295): `--title` is the explicit card label, and `TaskCreateArgs`
  keeps its pre-existing (misnamed) `title` key for the joined positional DESCRIPTION. These cases pin the
  separation: the two must never be confused, because the overload is what previously let a short title become
  the whole card description (and, per RUFU-269, let an unparsed flag become a stored title and poison the
  duplicate fingerprint).
  */
  it("keeps --title as the explicit label and the positional as the description", async () => {
    const parse = await loadParser();
    const args = parse(["Fix the lockfile so plugin workspaces install", "--title", "Fix lockfile drift"]);

    expect(args.explicitTitle).toBe("Fix lockfile drift");
    // The description keeps its full text: a title never replaces it.
    expect(args.title).toBe("Fix the lockfile so plugin workspaces install");
    expect(args.title).not.toContain("--title");
  });

  it("records --title wherever it sits in the argument order", async () => {
    const parse = await loadParser();

    expect(parse(["--title", "Rename on start", "desc text"]).explicitTitle).toBe("Rename on start");
    expect(parse(["--title", "Rename on start", "desc text"]).title).toBe("desc text");
  });

  it("treats a blank --title as no title at all so the derivation still runs", async () => {
    const parse = await loadParser();
    const args = parse(["desc text", "--title", "   "]);

    expect(args.explicitTitle).toBeUndefined();
    expect(args.title).toBe("desc text");
  });

  it("leaves no explicit title when --title is not passed", async () => {
    const parse = await loadParser();

    expect(parse(["desc text"]).explicitTitle).toBeUndefined();
  });
});
