/**
 * WorkflowOptionalStepsPanel — the workflow editor's optional-step authoring
 * surface. Sibling to {@link WorkflowFieldsPanel} / WorkflowSettingsPanel: lives
 * alongside the canvas in {@link WorkflowNodeEditor} and mutates the IR's
 * `optionalSteps` array through the same state/save flow (preserved across the
 * round-trip by `flowToIr`).
 *
 * A declaration is just `{ templateId, defaultOn? }`. Display metadata
 * (name/description/phase) is resolved from the built-in step-template catalog at
 * render time — never duplicated into the IR — so the resolver stays the single
 * source of truth. Unknown/stale template ids render a muted, still-removable row
 * rather than being silently dropped.
 */
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import { WORKFLOW_STEP_TEMPLATES, type WorkflowOptionalStep, type WorkflowStepTemplate } from "@fusion/core";
import { phaseBadge } from "./workflow-phase-badge";
import "./WorkflowOptionalStepsPanel.css";

interface WorkflowOptionalStepsPanelProps {
  optionalSteps: WorkflowOptionalStep[];
  onChange: (next: WorkflowOptionalStep[]) => void;
  readOnly: boolean;
  /** Plugin-contributed templates, merged into the catalog when available. */
  pluginTemplates?: WorkflowStepTemplate[];
}

export function WorkflowOptionalStepsPanel({
  optionalSteps,
  onChange,
  readOnly,
  pluginTemplates = [],
}: WorkflowOptionalStepsPanelProps) {
  const { t } = useTranslation("app");

  const templatesById = useMemo(() => {
    const map = new Map<string, WorkflowStepTemplate>();
    for (const tpl of [...WORKFLOW_STEP_TEMPLATES, ...pluginTemplates]) map.set(tpl.id, tpl);
    return map;
  }, [pluginTemplates]);

  const declaredIds = useMemo(() => new Set(optionalSteps.map((s) => s.templateId)), [optionalSteps]);

  // Catalog entries not already declared — the "Add optional step" picker source.
  const available = useMemo(
    () => [...templatesById.values()].filter((tpl) => !declaredIds.has(tpl.id)),
    [templatesById, declaredIds],
  );

  const addStep = useCallback(
    (templateId: string) => {
      if (!templateId || declaredIds.has(templateId)) return;
      onChange([...optionalSteps, { templateId, defaultOn: false }]);
    },
    [optionalSteps, onChange, declaredIds],
  );

  const removeStep = useCallback(
    (templateId: string) => onChange(optionalSteps.filter((s) => s.templateId !== templateId)),
    [optionalSteps, onChange],
  );

  const toggleDefaultOn = useCallback(
    (templateId: string, defaultOn: boolean) =>
      onChange(optionalSteps.map((s) => (s.templateId === templateId ? { ...s, defaultOn } : s))),
    [optionalSteps, onChange],
  );

  return (
    <aside className="wf-optional-steps-panel" data-testid="wf-optional-steps-panel">
      <header className="wf-optional-steps-header">
        <h3>{t("workflowOptionalSteps.title", "Optional steps")}</h3>
        <p className="wf-optional-steps-hint">
          {t(
            "workflowOptionalSteps.hint",
            "Steps a task can toggle on or off. Default sets the initial state for new tasks.",
          )}
        </p>
      </header>

      {optionalSteps.length === 0 ? (
        <p className="wf-optional-steps-empty">
          {t("workflowOptionalSteps.empty", "No optional steps. Add one to let tasks opt in or out.")}
        </p>
      ) : (
        <ul className="wf-optional-steps-list">
          {optionalSteps.map((step) => {
            const tpl = templatesById.get(step.templateId);
            const defaultOn = step.defaultOn ?? tpl?.defaultOn ?? false;
            return (
              <li
                key={step.templateId}
                className={`wf-optional-step-item${tpl ? "" : " is-unknown"}`}
                data-testid={`wf-optional-step-${step.templateId}`}
              >
                <div className="wf-optional-step-head">
                  <div className="wf-optional-step-title">
                    {tpl ? (
                      <>
                        <span className="wf-optional-step-name">{tpl.name}</span>
                        {phaseBadge(tpl.phase ?? "pre-merge", step.templateId, "wf-optional-step-phase", t)}
                      </>
                    ) : (
                      <span className="wf-optional-step-name wf-optional-step-name--unknown">
                        {t("workflowOptionalSteps.unknown", "Unknown step ({{id}})", { id: step.templateId })}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="wf-optional-step-remove"
                    aria-label={t("workflowOptionalSteps.remove", "Remove optional step")}
                    disabled={readOnly}
                    onClick={() => removeStep(step.templateId)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                {tpl?.description && (
                  <p className="wf-optional-step-description">{tpl.description}</p>
                )}
                <label className="wf-optional-step-default">
                  <input
                    type="checkbox"
                    checked={defaultOn}
                    disabled={readOnly}
                    aria-label={t("workflowOptionalSteps.defaultOnFor", "Default on for {{name}}", {
                      name: tpl?.name ?? step.templateId,
                    })}
                    onChange={(e) => toggleDefaultOn(step.templateId, e.target.checked)}
                  />
                  <span>{t("workflowOptionalSteps.defaultOn", "Default on")}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}

      {available.length > 0 && (
        <div className="wf-optional-steps-add">
          {/* Picker resets to placeholder after each add (value stays ""). */}
          <label className="wf-optional-steps-add-label" htmlFor="wf-optional-steps-add-select">
            <Plus size={13} /> {t("workflowOptionalSteps.add", "Add optional step")}
          </label>
          <select
            id="wf-optional-steps-add-select"
            data-testid="wf-optional-steps-add-select"
            value=""
            disabled={readOnly}
            onChange={(e) => {
              addStep(e.target.value);
              e.target.value = "";
            }}
          >
            <option value="" disabled>
              {t("workflowOptionalSteps.addPlaceholder", "Select a step…")}
            </option>
            {available.map((tpl) => (
              <option key={tpl.id} value={tpl.id}>
                {tpl.name}
              </option>
            ))}
          </select>
        </div>
      )}
    </aside>
  );
}

export default WorkflowOptionalStepsPanel;
