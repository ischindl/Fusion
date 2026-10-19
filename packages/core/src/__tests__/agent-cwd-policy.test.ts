import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, sep } from "node:path";
import {
  assertAgentCwdAllowed,
  FUSION_PROTECTED_CHECKOUTS_ENV,
  ProtectedCheckoutError,
} from "../agent-cwd-policy.js";

/*
FNXC:AgentWorkingDirectoryPolicy 2026-10-18-07:55:
RUFU-334 requires this matrix to cover the geometry, the parsing forms, and both failure classes,
because the defect this module closes was invisible in production for three weeks: an agent session
ran with the serve root as its cwd and a write grant on the same tree. The two `regression` cases at
the bottom exist because the first delivery of this card shipped an attribution allow-list and an
ancestor-direction refusal that this card's contract does not contain — a test asserting the removed
allow-list would have laundered the bypass back in, so these assert the new truth instead.

Fixtures resolve `tmpdir()` through `realpathSync` first: on macOS the temp root is itself a symlink,
and a fixture built on the symlinked spelling would differ from the module's realpath output for
reasons that have nothing to do with the policy under test.
*/

describe("assertAgentCwdAllowed (RUFU-334)", () => {
  let root: string;
  /** Stands in for the serve root: an ordinary checkout that must never be refused. */
  let project: string;
  /** Stands in for the production deployment checkout: `kb-worktrees/prod-deploy` on the real host. */
  let deploy: string;
  let deployNested: string;
  let sibling: string;

  beforeEach(() => {
    root = mkdtempSync(join(realpathSync(tmpdir()), "rufu-334-cwd-"));
    project = join(root, "serve");
    sibling = join(root, "other-worktree");
    deploy = join(root, "prod-deploy");
    deployNested = join(deploy, "apps", "web");
    mkdirSync(project, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    mkdirSync(deployNested, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const envWith = (...entries: string[]): NodeJS.ProcessEnv => ({
    [FUSION_PROTECTED_CHECKOUTS_ENV]: entries.join(delimiter),
  });

  describe("unset declaration is a no-op pass", () => {
    it("returns the realpath for a normal directory", () => {
      const result = assertAgentCwdAllowed(project, { env: {} });
      expect(result).toBe(realpathSync(project));
      expect(existsSync(result)).toBe(true);
    });

    it("treats a blank/whitespace-only value as unset", () => {
      for (const raw of ["", "   ", "\t", "\n", " \n\t "]) {
        expect(assertAgentCwdAllowed(project, { env: { [FUSION_PROTECTED_CHECKOUTS_ENV]: raw } })).toBe(
          realpathSync(project),
        );
      }
    });

    it("returns the realpath rather than the raw input", () => {
      const symlinked = join(root, "serve-link");
      symlinkSync(project, symlinked, "dir");
      // Trailing separator plus a symlinked spelling must both normalize away.
      expect(assertAgentCwdAllowed(`${symlinked}${sep}`, { env: {} })).toBe(realpathSync(project));
      expect(assertAgentCwdAllowed(join(project, "."), { env: {} })).toBe(realpathSync(project));
    });
  });

  describe("list parsing", () => {
    it("enforces every entry of a multi-entry list", () => {
      const env = envWith(deploy, project);
      expect(() => assertAgentCwdAllowed(deploy, { env })).toThrow(ProtectedCheckoutError);
      expect(() => assertAgentCwdAllowed(project, { env })).toThrow(ProtectedCheckoutError);
      expect(assertAgentCwdAllowed(sibling, { env })).toBe(realpathSync(sibling));
    });

    it("splits on the platform path delimiter and on newlines, and drops blanks and duplicates", () => {
      // Newline-delimited form: operators paste the value out of shell scripts and YAML blocks.
      const env: NodeJS.ProcessEnv = { [FUSION_PROTECTED_CHECKOUTS_ENV]: `\n${deploy}\r\n\r\n${deploy}\n` };
      expect(() => assertAgentCwdAllowed(deployNested, { env })).toThrow(ProtectedCheckoutError);
      expect(assertAgentCwdAllowed(sibling, { env })).toBe(realpathSync(sibling));
    });

    it("ignores a trailing separator on an entry", () => {
      const env: NodeJS.ProcessEnv = { [FUSION_PROTECTED_CHECKOUTS_ENV]: `${deploy}${sep}` };
      expect(() => assertAgentCwdAllowed(deploy, { env })).toThrow(ProtectedCheckoutError);
    });

    it("expands a leading `~` against the supplied env HOME, never an implicit homedir", () => {
      const homeEnv: NodeJS.ProcessEnv = { HOME: root, [FUSION_PROTECTED_CHECKOUTS_ENV]: "~/prod-deploy" };
      expect(() => assertAgentCwdAllowed(deploy, { env: homeEnv })).toThrow(ProtectedCheckoutError);
      expect(() => assertAgentCwdAllowed(join(root, "serve"), { env: { HOME: root, [FUSION_PROTECTED_CHECKOUTS_ENV]: "~/serve" } })).toThrow(
        ProtectedCheckoutError,
      );
      // Without a home in the injected env the entry stays literal, so a real directory under the
      // fixture root is NOT refused — proving the module never falls back to os.homedir().
      expect(assertAgentCwdAllowed(deploy, { env: { [FUSION_PROTECTED_CHECKOUTS_ENV]: "~/prod-deploy" } })).toBe(
        realpathSync(deploy),
      );
    });

    it("expands `~` alone to the home directory", () => {
      const env: NodeJS.ProcessEnv = { HOME: root, [FUSION_PROTECTED_CHECKOUTS_ENV]: "~" };
      // `root` is the home the entry names, so it is refused directly and everything below it is
      // refused as living inside it.
      expect(() => assertAgentCwdAllowed(root, { env })).toThrow(ProtectedCheckoutError);
      expect(() => assertAgentCwdAllowed(deploy, { env })).toThrow(ProtectedCheckoutError);
    });

    it("accepts the Windows list shape as written (delimiter-driven, not hard-coded)", () => {
      /*
      FNXC:AgentWorkingDirectoryPolicy 2026-10-18-07:55:
      The split is driven by `path.delimiter`, which is `;` on Windows and `:` on POSIX. This host is
      POSIX, so the `;` branch is asserted structurally rather than executed: a `;`-joined value is one
      path segment on POSIX and must therefore NOT split, while the same code path splits on the
      platform delimiter. The Windows behaviour is recorded as platform-unexercised in the task report
      rather than being claimed green here.
      */
      const windowsShape: NodeJS.ProcessEnv = { [FUSION_PROTECTED_CHECKOUTS_ENV]: `${deploy};${project}` };
      // On POSIX the whole value is a single (non-existent) entry: no refusal, and no crash.
      expect(assertAgentCwdAllowed(deploy, { env: windowsShape })).toBe(realpathSync(deploy));
      // The same two entries expressed with the platform delimiter do refuse, proving the split is
      // delimiter-driven and would therefore honour `;` on Windows.
      expect(() => assertAgentCwdAllowed(deploy, { env: envWith(deploy, project) })).toThrow(
        ProtectedCheckoutError,
      );
    });
  });

  describe("path geometry", () => {
    const env = (): NodeJS.ProcessEnv => envWith(deploy);

    it("refuses when the protected entry is equal to the cwd", () => {
      expect(() => assertAgentCwdAllowed(deploy, { env: env() })).toThrow(ProtectedCheckoutError);
    });

    it("refuses when the protected entry is a parent of the cwd (cwd lives inside it)", () => {
      expect(() => assertAgentCwdAllowed(deployNested, { env: env() })).toThrow(ProtectedCheckoutError);
    });

    it("passes a sibling of the protected path — the shape that must not over-refuse", () => {
      expect(assertAgentCwdAllowed(sibling, { env: env() })).toBe(realpathSync(sibling));
    });

    it("passes a directory that contains the protected path", () => {
      // The operator declaration means "never run an agent inside this checkout". Refusing the parent
      // would refuse an operator's own project root whenever a deployment is nested under it.
      expect(assertAgentCwdAllowed(root, { env: env() })).toBe(realpathSync(root));
    });

    it("refuses a real symlink pointing into the protected directory", () => {
      const intoDeploy = join(root, "link-into-deploy");
      symlinkSync(deployNested, intoDeploy, "dir");
      expect(() => assertAgentCwdAllowed(intoDeploy, { env: env() })).toThrow(ProtectedCheckoutError);
    });

    it("refuses a declaration that is itself only a symlink to the protected tree", () => {
      // The operator declared the logical path; the on-disk entry is a link, so only realpath
      // comparison can see that the real tree is the protected one.
      const alias = join(root, "deploy-alias");
      symlinkSync(deploy, alias, "dir");
      expect(lstatSync(alias).isSymbolicLink()).toBe(true);
      expect(() => assertAgentCwdAllowed(deploy, { env: envWith(alias) })).toThrow(ProtectedCheckoutError);
      expect(() => assertAgentCwdAllowed(deployNested, { env: envWith(alias) })).toThrow(
        ProtectedCheckoutError,
      );
    });

    it("never matches and never throws for an entry that does not exist", () => {
      const ghost = join(root, "ghost-deploy");
      const env: NodeJS.ProcessEnv = { [FUSION_PROTECTED_CHECKOUTS_ENV]: ghost };
      // Unrelated cwd passes, and the call survives the unreadable entry instead of poisoning the
      // probe the way the pre-fix lexical comparison did.
      expect(assertAgentCwdAllowed(project, { env })).toBe(realpathSync(project));
      expect(assertAgentCwdAllowed(sibling, { env })).toBe(realpathSync(sibling));
      expect(existsSync(ghost)).toBe(false);
    });

    it("does not match a sibling whose name merely starts with the protected entry", () => {
      // `/…/prod-deploy` must not match `/…/prod-deploy-evil` — the separator is part of the prefix.
      const evil = join(root, "prod-deploy-evil");
      mkdirSync(evil, { recursive: true });
      expect(assertAgentCwdAllowed(evil, { env: envWith(deploy) })).toBe(realpathSync(evil));
    });
  });

  describe("unusable candidates are TypeError, never a returned path", () => {
    it("refuses a non-existent cwd naming the path", () => {
      const missing = join(root, "does-not-exist");
      expect(() => assertAgentCwdAllowed(missing, { env: {} })).toThrow(TypeError);
      expect(() => assertAgentCwdAllowed(missing, { env: {} })).toThrow(/does-not-exist/);
    });

    it("refuses an empty and a whitespace-only cwd naming the path", () => {
      for (const value of ["", "   ", "\t\n"]) {
        let caught: unknown;
        try {
          assertAgentCwdAllowed(value, { env: {} });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(TypeError);
        expect((caught as Error).message).toContain("empty");
      }
    });

    it("refuses `.` rather than inheriting the process directory", () => {
      for (const value of [".", "./", ".\\"]) {
        expect(() => assertAgentCwdAllowed(value, { env: {} })).toThrow(TypeError);
      }
    });

    it("refuses a non-string candidate that leaked through an options bag", () => {
      for (const value of [undefined, null, 7, {}]) {
        expect(() => assertAgentCwdAllowed(value as unknown as string, { env: {} })).toThrow(TypeError);
      }
    });

    it("reports the TypeError before any protected-checkout verdict when both apply", () => {
      const ghost = join(root, "ghost-deploy");
      const env: NodeJS.ProcessEnv = { [FUSION_PROTECTED_CHECKOUTS_ENV]: ghost };
      expect(() => assertAgentCwdAllowed(ghost, { env })).toThrow(TypeError);
    });

    it("cannot be tricked into returning a path that does not exist", () => {
      // A file is not a directory candidate; realpath resolves it, so the caller must not read that as
      // a usable cwd. The policy's contract is a real path or a throw, and a file path is a real path —
      // so assert the observable boundary instead: every value the function returns exists on disk.
      const file = join(root, "a-file.txt");
      writeFileSync(file, "x");
      const returned = assertAgentCwdAllowed(file, { env: {} });
      expect(existsSync(returned)).toBe(true);
      expect(() => assertAgentCwdAllowed(join(file, "child"), { env: {} })).toThrow(TypeError);
    });
  });

  describe("refusal is informative and deterministic", () => {
    it("names the offending path, the protected entry, and the declaring variable", () => {
      let caught: ProtectedCheckoutError | undefined;
      try {
        assertAgentCwdAllowed(deployNested, { env: envWith(deploy), lane: "chat cli" });
      } catch (error) {
        caught = error as ProtectedCheckoutError;
      }
      expect(caught).toBeInstanceOf(ProtectedCheckoutError);
      expect(caught?.message).toContain(deployNested);
      expect(caught?.message).toContain(deploy);
      expect(caught?.message).toContain(FUSION_PROTECTED_CHECKOUTS_ENV);
      expect(caught?.message).toContain("chat cli");
      expect(caught?.name).toBe("ProtectedCheckoutError");
      expect(caught?.candidate).toBe(deployNested);
      expect(caught?.protectedRoot).toBe(deploy);
      expect(caught?.envVar).toBe("FUSION_PROTECTED_CHECKOUTS");
    });

    it("returns the same value for two consecutive calls with the same inputs", () => {
      const env = envWith(deploy);
      const first = assertAgentCwdAllowed(sibling, { env });
      const second = assertAgentCwdAllowed(sibling, { env });
      expect(second).toBe(first);
      expect(() => assertAgentCwdAllowed(deploy, { env })).toThrow(ProtectedCheckoutError);
      expect(() => assertAgentCwdAllowed(deploy, { env })).toThrow(ProtectedCheckoutError);
    });

    it("refuses a protected cwd even when the caller carries agent attribution", () => {
      /*
      FNXC:AgentWorkingDirectoryPolicy 2026-10-18-07:55:
      Guards the attribution allow-list removed in this card's Step 2. Fusion sets neither
      `FUSION_TASK_ID` nor `FUSION_AGENT_ID` anywhere — task attribution travels as the `Fusion-Task-Id`
      git commit trailer — so honouring them would have handed the gate to any process that could set its
      own environment. The invariant behind the reported case: no caller-supplied environment marker may
      waive an operator declaration.
      */
      const env: NodeJS.ProcessEnv = {
        ...envWith(deploy),
        FUSION_TASK_ID: "RUFU-334",
        FUSION_AGENT_ID: "agent-abc123",
      };
      expect(() => assertAgentCwdAllowed(deployNested, { env })).toThrow(ProtectedCheckoutError);
    });
  });
});
