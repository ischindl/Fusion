import "./AgentPermissionPolicyEditor.css";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  AGENT_PERMISSION_POLICY_ACTION_CATEGORIES,
  AGENT_PERMISSION_POLICY_CATEGORY_TOOL_EXAMPLES,
  AGENT_PERMISSION_POLICY_EXEMPT_TOOL_EXAMPLES,
  type AgentPermissionPolicy,
  type AgentPermissionPolicyDisposition,
  type AgentPermissionPolicyRules,
} from "@fusion/core";

type Mode = "project-default" | "agent-override";

interface Props {
  value: AgentPermissionPolicy | undefined;
  projectDefault?: Partial<AgentPermissionPolicyRules>;
  mode: Mode;
  onChange(next: AgentPermissionPolicy | undefined): void;
  disabled?: boolean;
}

const DISPOSITIONS: AgentPermissionPolicyDisposition[] = ["allow", "require-approval", "block"];

function getCategoryLabels(t: TFunction<"app">): Record<string, { label: string; description: string }> {
  return {
    git_write: { label: t("agentPolicy.category.gitWrite.label", "Git writes"), description: t("agentPolicy.category.gitWrite.description", "Commits, branch updates, and merge-affecting git changes.") },
    file_write_delete: { label: t("agentPolicy.category.fileWriteDelete.label", "File writes/deletes"), description: t("agentPolicy.category.fileWriteDelete.description", "Create, edit, or remove files in the workspace.") },
    command_execution: { label: t("agentPolicy.category.commandExecution.label", "Command execution"), description: t("agentPolicy.category.commandExecution.description", "Runs shell commands and scripts.") },
    network_api: { label: t("agentPolicy.category.networkApi.label", "Network/API"), description: t("agentPolicy.category.networkApi.description", "Outbound network or API access.") },
    task_agent_mutation: { label: t("agentPolicy.category.taskAgentMutation.label", "Task/agent mutation"), description: t("agentPolicy.category.taskAgentMutation.description", "Task state changes, delegation, or agent lifecycle actions.") },
  };
}

function getDispositionLabel(t: TFunction<"app">, disposition: AgentPermissionPolicyDisposition): string {
  if (disposition === "require-approval") return t("agentPolicy.requireApproval", "Require approval");
  if (disposition === "allow") return t("agentPolicy.allow", "Allow");
  if (disposition === "block") return t("agentPolicy.block", "Block");
  // Forward-compat fallback if the disposition union ever grows.
  const raw: string = disposition;
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function buildAllowRules(): AgentPermissionPolicyRules {
  return {
    git_write: "allow",
    file_write_delete: "allow",
    command_execution: "allow",
    network_api: "allow",
    task_agent_mutation: "allow",
  };
}

const PRESET_RULES: Record<"unrestricted" | "approval-required" | "locked-down", AgentPermissionPolicyRules> = {
  unrestricted: {
    git_write: "allow",
    file_write_delete: "allow",
    command_execution: "allow",
    network_api: "allow",
    task_agent_mutation: "allow",
  },
  "approval-required": {
    git_write: "require-approval",
    file_write_delete: "require-approval",
    command_execution: "require-approval",
    network_api: "require-approval",
    task_agent_mutation: "require-approval",
  },
  "locked-down": {
    git_write: "block",
    file_write_delete: "block",
    command_execution: "block",
    network_api: "block",
    task_agent_mutation: "block",
  },
};

function getPresetRules(presetId: "unrestricted" | "approval-required" | "locked-down"): AgentPermissionPolicyRules {
  return PRESET_RULES[presetId];
}

function matchesRules(a: AgentPermissionPolicyRules, b: AgentPermissionPolicyRules): boolean {
  return AGENT_PERMISSION_POLICY_ACTION_CATEGORIES.every((category) => a[category] === b[category]);
}

function derivePresetFromRules(rules: AgentPermissionPolicyRules): AgentPermissionPolicy["presetId"] {
  if (matchesRules(rules, PRESET_RULES.unrestricted)) return "unrestricted";
  if (matchesRules(rules, PRESET_RULES["approval-required"])) return "approval-required";
  if (matchesRules(rules, PRESET_RULES["locked-down"])) return "locked-down";
  return "custom";
}

export function AgentPermissionPolicyEditor({ value, projectDefault, mode, onChange, disabled = false }: Props) {
  const { t } = useTranslation("app");
  const categoryLabels = getCategoryLabels(t as TFunction<"app">);
  const derivedPreset = value ? derivePresetFromRules(value.rules) : "unrestricted";
  const currentPreset = mode === "agent-override" && !value ? "inherit" : (value?.presetId === "custom" ? derivedPreset : (value?.presetId ?? "unrestricted"));
  const rules = value?.rules ?? buildAllowRules();

  const setPreset = (preset: string) => {
    if (mode === "agent-override" && preset === "inherit") {
      onChange(undefined);
      return;
    }
    if (preset === "custom") {
      onChange({ presetId: "custom", rules: { ...rules } });
      return;
    }
    onChange({ presetId: preset as AgentPermissionPolicy["presetId"], rules: getPresetRules(preset as "unrestricted" | "approval-required" | "locked-down") });
  };

  const setRule = (category: keyof AgentPermissionPolicyRules, next: string) => {
    if (mode === "agent-override" && next === "inherit") {
      if (!value) return;
      const nextRules = { ...value.rules };
      nextRules[category] = projectDefault?.[category] ?? "allow";
      onChange({ presetId: "custom", rules: nextRules });
      return;
    }
    const nextRules = { ...rules, [category]: next as AgentPermissionPolicyDisposition };
    onChange({ presetId: "custom", rules: nextRules });
  };

  return (
    <div className="agent-policy-editor card">
      <div className="form-group">
        <label htmlFor="agent-policy-preset">{t("agentPolicy.preset", "Preset")}</label>
        <select
          id="agent-policy-preset"
          className="select"
          value={currentPreset}
          onChange={(event) => setPreset(event.target.value)}
          disabled={disabled}
        >
          {mode === "agent-override" ? <option value="inherit">{t("agentPolicy.inheritDefault", "Inherit project default")}</option> : null}
          <option value="unrestricted">{t("agentPolicy.unrestricted", "Unrestricted")}</option>
          <option value="approval-required">{t("agentPolicy.approvalRequired", "Approval Required")}</option>
          <option value="locked-down">{t("agentPolicy.lockedDown", "Locked Down")}</option>
          <option value="custom">{t("agentPolicy.custom", "Custom")}</option>
        </select>
      </div>

      <div className="agent-policy-table" role="table" aria-label={t("agentPolicy.ariaLabel", "Permission policy categories")}>
        {AGENT_PERMISSION_POLICY_ACTION_CATEGORIES.map((category) => {
          const meta = categoryLabels[category] ?? { label: category, description: "" };
          const inherited = projectDefault?.[category] ?? "allow";
          const effective = rules[category] ?? "allow";
          const rowValue = mode === "agent-override" && !value ? "inherit" : effective;
          return (
            <div key={category} className="agent-policy-row" role="row" data-category={category}>
              <div className="agent-policy-cell">
                <strong>{meta.label}</strong>
                <div className="agent-policy-description">{meta.description}</div>
                <ul className="agent-policy-examples" aria-label={t("agentPolicy.categoryExamples", "{{label}} examples", { label: meta.label })}>
                  {(AGENT_PERMISSION_POLICY_CATEGORY_TOOL_EXAMPLES[category] ?? []).map((toolName) => (
                    <li key={`${category}-${toolName}`}>
                      <code>{toolName}</code>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="agent-policy-cell">
                <select
                  className="select"
                  value={rowValue}
                  onChange={(event) => setRule(category, event.target.value)}
                  disabled={disabled}
                >
                  {mode === "agent-override" ? <option value="inherit">{t("agentPolicy.inherit", "Inherit")}</option> : null}
                  {DISPOSITIONS.map((disposition) => (
                    <option key={disposition} value={disposition}>
                      {getDispositionLabel(t as TFunction<"app">, disposition)}
                    </option>
                  ))}
                </select>
                {mode === "agent-override" && rowValue === "inherit" ? (
                  <div className="agent-policy-inherit-note">{t("agentPolicy.fromProjectDefault", "from project default")}: {getDispositionLabel(t as TFunction<"app">, inherited)}</div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <details className="agent-policy-exempt" open={false}>
        <summary>{t("agentPolicy.exemptTools", "Tools exempt from approval policy")}</summary>
        <p>
          {t("agentPolicy.exemptToolsDescription", "These coordination tools bypass approval policy so heartbeats and inter-agent messaging cannot deadlock. They are not user-configurable.")}
        </p>
        <ul className="agent-policy-exempt-list">
          {AGENT_PERMISSION_POLICY_EXEMPT_TOOL_EXAMPLES.map((toolName) => (
            <li key={toolName}>
              <code>{toolName}</code>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
