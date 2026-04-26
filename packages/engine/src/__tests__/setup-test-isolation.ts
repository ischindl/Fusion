/**
 * Global test isolation: prevents engine tests from writing to the real ~/.fusion/ directory.
 *
 * This runs in every Vitest worker before shared setup. By forcing process.env.HOME
 * to a fresh temp directory, homedir()-derived paths resolve to isolated locations.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempHome = mkdtempSync(join(tmpdir(), "fn-test-home-"));
process.env.HOME = tempHome;
