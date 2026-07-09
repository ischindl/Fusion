import { describe, expect, it } from "vitest";
import {
  AGENT_PERMISSION_POLICY_CATEGORY_TOOL_EXAMPLES,
  AGENT_PERMISSION_POLICY_EXEMPT_TOOL_EXAMPLES,
  DEFAULT_AGENT_PERMISSION_POLICY_PRESET_ID,
  getBuiltInAgentPermissionPolicyPresets,
  isAgentPermissionPolicyPresetId,
  normalizeAgentPermissionPolicy,
  normalizeAgentPermissionPolicyFromPreset,
  resolveEffectiveAgentPermissionPolicy,
} from "../agent-permission-policy.js";
import { AGENT_PERMISSION_POLICY_ACTION_CATEGORIES } from "../types.js";
import {
  ACTION_GATE_TASK_AGENT_MANAGEMENT_TOOLS,
  COORDINATION_EXEMPT_TOOLS,
} from "../../../engine/src/gating-classifications.js";

describe("agent-permission-policy", () => {
  it("returns the canonical built-in preset catalog", () => {
    const presets = getBuiltInAgentPermissionPolicyPresets();
    expect(presets.map((preset) => preset.id)).toEqual([
      "unrestricted",
      "approval-required",
      "locked-down",
      "custom",
    ]);
  });

  it("normalizes unrestricted preset with all categories allow, except review_gate_bypass which stays require-approval", () => {
    // FN-7728: review_gate_bypass intentionally diverges from the uniform unrestricted default —
    // a merge-gate bypass must never be silently allowed by default even under the permissive preset.
    const policy = normalizeAgentPermissionPolicyFromPreset("unrestricted");
    for (const category of AGENT_PERMISSION_POLICY_ACTION_CATEGORIES) {
      if (category === "review_gate_bypass") {
        expect(policy.rules[category]).toBe("require-approval");
        continue;
      }
      expect(policy.rules[category]).toBe("allow");
    }
  });

  it("normalizes approval-required preset with all categories require-approval", () => {
    const policy = normalizeAgentPermissionPolicyFromPreset("approval-required");
    for (const category of AGENT_PERMISSION_POLICY_ACTION_CATEGORIES) {
      expect(policy.rules[category]).toBe("require-approval");
    }
  });

  it("normalizes locked-down preset with all categories block", () => {
    const policy = normalizeAgentPermissionPolicyFromPreset("locked-down");
    for (const category of AGENT_PERMISSION_POLICY_ACTION_CATEGORIES) {
      expect(policy.rules[category]).toBe("block");
    }
  });

  it("resolves legacy missing policy to unrestricted default", () => {
    const effective = resolveEffectiveAgentPermissionPolicy(undefined);
    expect(effective.presetId).toBe(DEFAULT_AGENT_PERMISSION_POLICY_PRESET_ID);
    for (const category of AGENT_PERMISSION_POLICY_ACTION_CATEGORIES) {
      if (category === "review_gate_bypass") {
        expect(effective.rules[category]).toBe("require-approval");
        continue;
      }
      expect(effective.rules[category]).toBe("allow");
    }
    expect(effective.toolRules).toBeUndefined();
  });

  it("normalizes exact tool overrides without changing category preset semantics", () => {
    const policy = normalizeAgentPermissionPolicy({
      presetId: "unrestricted",
      toolRules: { fn_task_create: "block" },
    });

    expect(policy.rules.task_agent_mutation).toBe("allow");
    expect(policy.toolRules).toEqual({ fn_task_create: "block" });
  });

  it("omits empty exact tool override maps", () => {
    const policy = normalizeAgentPermissionPolicy({ presetId: "custom", toolRules: {} });
    expect(policy.toolRules).toBeUndefined();
  });

  it("resolves malformed policy payload to unrestricted default", () => {
    const effective = resolveEffectiveAgentPermissionPolicy({
      presetId: "not-a-preset" as never,
      rules: {
        "git-write": "block",
        "file-write-delete": "block",
        "shell-command": "block",
        "network-api": "block",
        "task-agent-management": "block",
      },
    });
    expect(effective.presetId).toBe(DEFAULT_AGENT_PERMISSION_POLICY_PRESET_ID);
  });

  it("validates known preset IDs", () => {
    expect(isAgentPermissionPolicyPresetId("unrestricted")).toBe(true);
    expect(isAgentPermissionPolicyPresetId("approval-required")).toBe(true);
    expect(isAgentPermissionPolicyPresetId("locked-down")).toBe(true);
    expect(isAgentPermissionPolicyPresetId("custom")).toBe(true);
  });

  it("provides non-empty tool examples for every action category", () => {
    for (const category of AGENT_PERMISSION_POLICY_ACTION_CATEGORIES) {
      expect(AGENT_PERMISSION_POLICY_CATEGORY_TOOL_EXAMPLES[category].length).toBeGreaterThan(0);
    }
  });

  it("includes key discoverability examples", () => {
    expect(AGENT_PERMISSION_POLICY_CATEGORY_TOOL_EXAMPLES.network_api).toContain("fn_research_run (web/research)");
    expect(AGENT_PERMISSION_POLICY_CATEGORY_TOOL_EXAMPLES.network_api).toContain("fn_web_fetch");
    expect(AGENT_PERMISSION_POLICY_CATEGORY_TOOL_EXAMPLES.task_agent_mutation).toContain("fn_task_create");
    expect(AGENT_PERMISSION_POLICY_EXEMPT_TOOL_EXAMPLES).toContain("fn_send_message");
  });

  it("keeps task-agent mutation examples aligned with action-gate tool classifications", () => {
    for (const toolName of AGENT_PERMISSION_POLICY_CATEGORY_TOOL_EXAMPLES.task_agent_mutation) {
      expect(toolName.startsWith("fn_")).toBe(true);
      expect(ACTION_GATE_TASK_AGENT_MANAGEMENT_TOOLS.has(toolName)).toBe(true);
    }
  });

  it("keeps exempt examples aligned with coordination-exempt classifications", () => {
    for (const toolName of AGENT_PERMISSION_POLICY_EXEMPT_TOOL_EXAMPLES) {
      expect(COORDINATION_EXEMPT_TOOLS).toContain(toolName);
    }
  });

  // FN-7728: review_gate_bypass regression coverage.
  describe("review_gate_bypass category", () => {
    it("is a distinct category from task_agent_mutation with fn_task_bypass_review as its example tool", () => {
      expect(AGENT_PERMISSION_POLICY_ACTION_CATEGORIES).toContain("review_gate_bypass");
      expect(AGENT_PERMISSION_POLICY_CATEGORY_TOOL_EXAMPLES.review_gate_bypass).toEqual(["fn_task_bypass_review"]);
      expect(AGENT_PERMISSION_POLICY_CATEGORY_TOOL_EXAMPLES.task_agent_mutation).not.toContain("fn_task_bypass_review");
    });

    it("defaults to require-approval under approval-required and block under locked-down", () => {
      expect(normalizeAgentPermissionPolicyFromPreset("approval-required").rules.review_gate_bypass).toBe("require-approval");
      expect(normalizeAgentPermissionPolicyFromPreset("locked-down").rules.review_gate_bypass).toBe("block");
    });

    it("can be overridden independently under a custom policy without changing task_agent_mutation", () => {
      const policy = normalizeAgentPermissionPolicy({
        presetId: "custom",
        rules: { review_gate_bypass: "allow" },
      });

      expect(policy.rules.review_gate_bypass).toBe("allow");
      expect(policy.rules.task_agent_mutation).toBe("allow");
    });

    it("resolves a stored policy missing the review_gate_bypass key to the preset default (no migration required)", () => {
      const effective = resolveEffectiveAgentPermissionPolicy({
        presetId: "custom",
        rules: { task_agent_mutation: "block" } as never,
      });

      expect(effective.rules.review_gate_bypass).toBe("require-approval");
    });

    it("lets the project default override review_gate_bypass independently", () => {
      const effective = resolveEffectiveAgentPermissionPolicy(undefined, {
        rules: { review_gate_bypass: "block" },
      });

      expect(effective.rules.review_gate_bypass).toBe("block");
      expect(effective.rules.task_agent_mutation).toBe("allow");
    });
  });
});
