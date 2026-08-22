/*
FNXC:RUFU-140 2026-08-21-03:55:
packages/dashboard's test-check program (tsconfig.test-check.json, the repo's
only typecheck surface covering dashboard test files) pulls the root
eslint.config.mjs in via app/__tests__/eslint-no-nested-components.test.ts,
which imports the rule object to pin the fusion-react rule's behavior. Under
moduleResolution "bundler" the .mjs -> .d.mts pairing types that import
without allowJs. Type-only: no runtime effect on the ESLint flat config.
*/
import type { Rule } from "eslint";

export const noNestedComponentDefinitions: Rule.RuleModule;
