/*
FNXC:PostMergeEvidenceContract 2026-11-06-05:21 (RUFU-464):
This module is deliberately NOT a `.test.ts` file, and that placement is the entire point of it.
`packages/core/tsconfig.json` compiles the whole `src` tree while excluding every `*.test.ts` from that
program, so a `satisfies WorkflowOptionalGroupConfig` clause is checked by
`pnpm --filter @fusion/core typecheck` only when it lives here; the identical clause inside a test file would
never be read by the typecheck program and a green typecheck would prove nothing. The `satisfies` clause IS
the assertion here: it refuses to compile when the typed authoring surface cannot carry a kind the runtime
vocabulary accepts. vitest collects only `*.test.ts` files, so this module adds no test-collection surface -
the runtime half of the guarantee is asserted by the pins in `post-merge-evidence-requirement.test.ts`, which
imports and consumes the fixtures below.

Measured defect this guards: RUFU-457 widened post-merge evidence to four kinds across the
`PostMergeEvidenceKind` union, `POST_MERGE_EVIDENCE_KINDS`, `parseWorkflowIr` and `docs/workflow-steps.md`,
but left `WorkflowOptionalGroupConfig.evidence.kind` enumerating only the two original values. A workflow
authored in TypeScript therefore could not write `"onedev-pipeline"` or `"gitlab-pipeline"` at all, so the
"authored choice wins" promise was reachable only from hand-edited JSON. One fixture per kind, so the guard
covers the whole vocabulary rather than only the two that were broken, and each fixture is consumed at runtime
so the module cannot be deleted to make the typecheck go green.
*/
import type {
  WorkflowIrEdge,
  WorkflowIrNode,
  WorkflowOptionalGroupConfig,
} from "../workflows/workflow-ir-types.js";
import type { PostMergeEvidenceKind } from "../workflows/builtin-post-merge-group.js";

/**
 * The smallest template an `optional-group` config accepts, typed explicitly so the `kind` literal
 * reconciles against `WorkflowIrNodeKind` instead of widening to `string`.
 */
function trivialTemplate(): { nodes: WorkflowIrNode[]; edges: WorkflowIrEdge[] } {
  return { nodes: [{ id: "typed-authoring-inner", kind: "prompt" }], edges: [] };
}

export const FULL_SUITE_AUTHORED = {
  name: "typed-full-suite",
  phase: "post-merge",
  evidence: { kind: "github-actions-full-suite" },
  template: trivialTemplate(),
} satisfies WorkflowOptionalGroupConfig;

export const INTEGRATION_ONLY_AUTHORED = {
  name: "typed-integration-only",
  phase: "post-merge",
  evidence: { kind: "integration-only" },
  template: trivialTemplate(),
} satisfies WorkflowOptionalGroupConfig;

export const ONEDEV_AUTHORED = {
  name: "typed-onedev-pipeline",
  phase: "post-merge",
  evidence: { kind: "onedev-pipeline" },
  template: trivialTemplate(),
} satisfies WorkflowOptionalGroupConfig;

export const GITLAB_AUTHORED = {
  name: "typed-gitlab-pipeline",
  phase: "post-merge",
  evidence: { kind: "gitlab-pipeline" },
  template: trivialTemplate(),
} satisfies WorkflowOptionalGroupConfig;

/**
 * Every kind in the vocabulary as a typed-authored config paired with the literal it authored. The typecheck
 * program proves each `evidence.kind` is writable on the config type; the consuming test proves each reader
 * returns that same literal back.
 */
export const TYPED_AUTHORED_EVIDENCE_FIXTURES: ReadonlyArray<{
  kind: PostMergeEvidenceKind;
  config: WorkflowOptionalGroupConfig;
}> = [
  { kind: FULL_SUITE_AUTHORED.evidence.kind, config: FULL_SUITE_AUTHORED },
  { kind: INTEGRATION_ONLY_AUTHORED.evidence.kind, config: INTEGRATION_ONLY_AUTHORED },
  { kind: ONEDEV_AUTHORED.evidence.kind, config: ONEDEV_AUTHORED },
  { kind: GITLAB_AUTHORED.evidence.kind, config: GITLAB_AUTHORED },
];
