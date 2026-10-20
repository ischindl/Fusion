/*
FNXC:ProjectRoutingVisibility 2026-09-22-16:37:
Acceptance matrix for the pure routing report behind `fn task create|duplicate|refine`. The measured
incident: cwd `/home/dev/git/Fusion` (registered `runfusion`), central default `gedapp`, and `fn task create`
printed only `Project: gedapp` plus a relative `.fusion/tasks/RUFU-242/` path, so a card filed into another
project looked local.

FNXC:DefaultProjectNotARouter 2026-10-20-19:46 (RUFU-572):
The mismatch warning and the `[y/N]` confirmation are DELETED together with the routing source that could
produce them. `resolveProject` now targets `--project` (the reserved `@default` included) or the current
directory, so a card that lands outside the cwd requires the operator to have named that project themselves
and nothing here may second-guess it. What stays under test is the part that must not drift across the three
card-minting commands: the single shared target line per provenance value, the unregistered-cwd sentence, and
the absolute card path.
*/
import { describe, it, expect } from "vitest";
import {
  cardDirectoryPath,
  evaluateProjectRouting,
  unregisteredCwdProjectWarning,
} from "../project-routing.js";

const GEDAPP_PATH = "/home/dev/work/gedapp";

describe("evaluateProjectRouting", () => {
  it("names the target and its provenance when --project chose it", () => {
    const decision = evaluateProjectRouting({
      projectName: "gedapp",
      projectPath: GEDAPP_PATH,
      resolvedFrom: "flag",
    });

    expect(decision.targetLine).toContain("Project: gedapp");
    expect(decision.targetLine).toContain(GEDAPP_PATH);
    expect(decision.targetLine).toContain("resolved via the --project flag");
  });

  it("reports an @default target as the flag the operator actually typed", () => {
    /*
    FNXC:DefaultProjectNotARouter 2026-10-20-19:46 (RUFU-572): `--project @default` dereferences the stored
    default, and `resolveProject` records it as `flag`. There is no `default` provenance to label any more, so
    the operator reads the truth: they asked for this project on the command line.
    */
    const decision = evaluateProjectRouting({
      projectName: "gedapp",
      projectPath: GEDAPP_PATH,
      resolvedFrom: "flag",
    });

    expect(decision.targetLine).not.toContain("default project");
    expect(decision.targetLine).toContain("--project flag");
  });

  it("names the target without second-guessing a cwd resolution", () => {
    const decision = evaluateProjectRouting({
      projectName: "runfusion",
      projectPath: "/home/dev/git/Fusion",
      resolvedFrom: "cwd",
    });

    expect(decision.targetLine).toContain("resolved via current-directory detection");
  });

  it("keeps the unregistered-cwd fallback to its own louder message", () => {
    const decision = evaluateProjectRouting({
      projectName: "new-thing",
      projectPath: "/home/dev/git/new-thing",
      resolvedFrom: "cwd-fallback",
    });

    expect(decision.targetLine).toContain("an unregistered local project in the current directory");
  });

  it("leaves a hand-built context (no provenance) as a bare target line", () => {
    const decision = evaluateProjectRouting({ projectName: "gedapp", projectPath: GEDAPP_PATH });

    expect(decision.targetLine).toBe("  Project: gedapp");
  });

  it("returns nothing but the target line, because there is no warning or prompt left to decide", () => {
    const decision = evaluateProjectRouting({
      projectName: "gedapp",
      projectPath: GEDAPP_PATH,
      resolvedFrom: "flag",
    });

    expect(Object.keys(decision)).toEqual(["targetLine"]);
  });
});

describe("routing message wording", () => {
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
cases guard the parse half of that fix and pin that `--yes` never quietly grows into a bypass of the
duplicate guards, even though RUFU-572 deleted the routing confirm it used to answer.
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

  it("leaves the duplicate guards on: --yes stays inert on card minting", async () => {
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
