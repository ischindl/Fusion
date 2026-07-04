/*
FNXC:SkillSync 2026-07-01-20:05:
`src/extension.ts` registers the workflow-authoring + trait tools at module load, pulling their TypeBox param schemas and `createWorkflowAuthoringTools` from `@fusion/engine`. Any test that replaces `@fusion/engine` with a bare `vi.mock` factory must therefore still expose these named exports, or importing `../extension.js` throws `No "workflowListParams" export is defined on the "@fusion/engine" mock`. Centralize the passthrough stubs here so a future engine workflow-tool addition only updates one place instead of drifting each extension test's factory. The param schemas are used only as `.parameters` passthroughs and `createWorkflowAuthoringTools` is only invoked in the exec path, so empty schemas / an empty tool list keep the module-load contract without exercising engine behavior.
*/

/** Stub TypeBox param schema — only ever forwarded as a tool `.parameters` value. */
const emptyParams = {} as const;

export const workflowAuthoringEngineMock = {
  workflowListParams: emptyParams,
  workflowGetParams: emptyParams,
  workflowSelectParams: emptyParams,
  workflowCreateParams: emptyParams,
  workflowUpdateParams: emptyParams,
  workflowDeleteParams: emptyParams,
  workflowSettingsParams: emptyParams,
  traitListParams: emptyParams,
  createWorkflowAuthoringTools: () => [] as unknown[],
};
