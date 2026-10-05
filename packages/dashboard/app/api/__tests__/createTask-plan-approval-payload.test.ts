import { beforeEach, describe, expect, it, vi } from "vitest";

const proxyApiMock = vi.hoisted(() => vi.fn());

vi.mock("../client/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client/client.js")>();
  return {
    ...actual,
    proxyApi: proxyApiMock,
  };
});

import { createTask } from "../tasks/tasks.js";

function postedBody(): Record<string, unknown> {
  const options = proxyApiMock.mock.calls.at(-1)?.[1] as RequestInit | undefined;
  return JSON.parse(String(options?.body)) as Record<string, unknown>;
}

describe("createTask plan approval payload", () => {
  beforeEach(() => {
    proxyApiMock.mockReset();
    proxyApiMock.mockResolvedValue({ id: "FN-234" });
  });

  it("omits the retired task override from ordinary and legacy-shaped inputs", async () => {
    await createTask({ description: "Use project policy" });
    expect(postedBody()).not.toHaveProperty("requirePlanApproval");

    await createTask({ description: "Ignore legacy override", requirePlanApproval: true } as never);
    expect(postedBody()).not.toHaveProperty("requirePlanApproval");
  });

  /*
  FNXC:CreateTaskPayload 2026-10-05-08:27:
  The client contract is the serialized request body, not createTask source layout. Exercise the
  production client seam so supported overrides remain forwarded while the retired per-task plan
  approval field cannot return through a legacy-shaped browser input.
  */
  it("forwards supported create-time overrides while omitting the retired override", async () => {
    await createTask({
      description: "Create with explicit workflow behavior",
      executionMode: "fast",
      plannerOversightLevel: "strict",
      sessionAdvisorEnabled: true,
      enabledWorkflowSteps: ["plan-review", "code-review"],
      requirePlanApproval: true,
      humanPlanApproval: true,
    } as never);

    expect(postedBody()).toMatchObject({
      description: "Create with explicit workflow behavior",
      executionMode: "fast",
      plannerOversightLevel: "strict",
      sessionAdvisorEnabled: true,
      enabledWorkflowSteps: ["plan-review", "code-review"],
      /*
      FNXC:HumanPlanApproval 2026-10-05-11:29 (merge origin/main, FN-408 ours kept):
      FN-408's per-card arming flag is this fork's replacement for the retired `requirePlanApproval`
      field, and it must survive the same client seam that strips the retired one. Upstream's version
      of this test was authored before FN-408 existed, so the field is added to the forwarded set here;
      without it a regression that drops `humanPlanApproval` from the request body is invisible, and
      the previous version of this file only asserted the field appeared somewhere in createTask's
      source text - which is exactly the source-text assertion this repo forbids.
      */
      humanPlanApproval: true,
    });
    expect(postedBody()).not.toHaveProperty("requirePlanApproval");
  });
});
