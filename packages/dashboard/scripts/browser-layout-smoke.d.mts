/*
FNXC:RUFU-140 2026-08-21-03:55:
tsconfig.test-check.json is the repo's only typecheck program that includes
dashboard test files, and app/__tests__/browser-layout-smoke-fixture.test.ts
imports this fixture script by relative path. Under moduleResolution "bundler"
the .mjs -> .d.mts pairing types that import without allowJs. Type-only: no
runtime effect, no behavior change to the smoke script itself.
*/
export const QUICK_ADD_SAVE_FIXTURE_COUNT: number;
export function buildQuickAddSaveFixtures(labels?: readonly (readonly [string, string])[]): string;
export function createSmokeHtml(options?: object): string;
export function prepareBrowserSmoke(
  executable: string,
  options?: {
    startFixture?: (...args: never[]) => Promise<unknown>;
    launch?: (...args: never[]) => Promise<unknown>;
    closeFixture?: (...args: never[]) => Promise<void>;
  },
): Promise<unknown>;
