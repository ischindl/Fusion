import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Agent, AgentOnboardingSummary, ConversationHistoryEntry, ExistingAgentOnboardingConfig, OnboardingMode } from "../api";
import {
  cancelAgentOnboarding,
  connectAgentOnboardingStream,
  respondToAgentOnboarding,
  startAgentOnboardingStreaming,
} from "../api";
import { AGENT_PRESETS } from "./agent-presets";
import { ConversationHistory } from "./ConversationHistory";
import "./ExperimentalAgentOnboardingModal.css";

type ViewState = "initial" | "loading" | "question" | "summary" | "error";

interface ExperimentalAgentOnboardingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onUseDraft: (summary: AgentOnboardingSummary) => void;
  projectId?: string;
  existingAgents: Agent[];
  mode?: OnboardingMode;
  existingAgentConfig?: ExistingAgentOnboardingConfig;
}

export function ExperimentalAgentOnboardingModal({
  isOpen,
  onClose,
  onUseDraft,
  projectId,
  existingAgents,
  mode = "create",
  existingAgentConfig,
}: ExperimentalAgentOnboardingModalProps) {
  const { t } = useTranslation("app");
  const [viewState, setViewState] = useState<ViewState>("initial");
  const [intent, setIntent] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [currentQuestion, setCurrentQuestion] = useState("");
  const [currentQuestionId, setCurrentQuestionId] = useState("answer");
  const [answer, setAnswer] = useState("");
  const [summary, setSummary] = useState<AgentOnboardingSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<ConversationHistoryEntry[]>([]);
  const isEditMode = mode === "edit";

  const resetState = useCallback(() => {
    setViewState("initial");
    setIntent("");
    setSessionId(null);
    setCurrentQuestion("");
    setCurrentQuestionId("answer");
    setAnswer("");
    setSummary(null);
    setError(null);
    setHistory([]);
  }, []);

  const templateOptions = useMemo(
    () => AGENT_PRESETS.map((preset) => ({ id: preset.id, label: preset.name, description: preset.description })),
    [],
  );

  useEffect(() => {
    if (!sessionId) return;
    const stream = connectAgentOnboardingStream(sessionId, projectId, {
      onThinking: (data) => {
        setHistory((current) => {
          const next = [...current];
          const last = next[next.length - 1];
          if (last && !last.question) {
            next[next.length - 1] = { ...last, thinkingOutput: `${last.thinkingOutput ?? ""}${data}` };
            return next;
          }
          return [...next, { response: {}, thinkingOutput: data }];
        });
      },
      onQuestion: (q) => {
        setCurrentQuestion(q.question);
        setCurrentQuestionId(q.id);
        setViewState("question");
      },
      onSummary: (nextSummary) => {
        setSummary(nextSummary);
        setViewState("summary");
      },
      onError: (message) => {
        setError(message);
        setViewState("error");
      },
    });
    return () => stream.close();
  }, [sessionId, projectId]);

  const handleClose = async () => {
    try {
      if (sessionId) {
        await cancelAgentOnboarding(sessionId, projectId);
      }
    } catch {
      // Best-effort server-side cleanup; always allow modal dismissal.
    } finally {
      resetState();
      onClose();
    }
  };

  useEffect(() => {
    if (!isOpen) {
      resetState();
    }
  }, [isOpen, resetState]);

  if (!isOpen) return null;

  const renderSummaryValue = (value: string | number | null | undefined) => {
    if (value === undefined || value === null || value === "") {
      return <em className="experimental-agent-onboarding-modal__summary-empty">{t("agents.onboarding.notSet", "Not set")}</em>;
    }
    return <span>{value}</span>;
  };

  const start = async () => {
    setViewState("loading");
    setError(null);
    try {
      const result = await startAgentOnboardingStreaming(
        intent,
        {
          mode,
          existingAgentConfig,
          existingAgents: existingAgents.map((agent) => ({ id: agent.id, name: agent.name, role: agent.role })),
          templates: templateOptions,
        },
        projectId,
      );
      setSessionId(result.sessionId);
    } catch (err) {
      setError((err as Error).message);
      setViewState("error");
    }
  };

  const submitAnswer = async () => {
    if (!sessionId) return;
    setViewState("loading");
    setError(null);
    try {
      const responsePayload = { [currentQuestionId]: answer };
      setHistory((current) => [
        ...current,
        {
          question: { id: currentQuestionId, type: "text", question: currentQuestion },
          response: responsePayload,
        },
      ]);
      await respondToAgentOnboarding(sessionId, responsePayload, projectId);
      setAnswer("");
    } catch (err) {
      setError((err as Error).message);
      setViewState("error");
    }
  };

  const handleConfirmDraft = async () => {
    if (!summary) return;
    onUseDraft(summary);
    await handleClose();
  };

  return (
    <div className="modal-overlay open" role="presentation">
      <div className="modal modal-lg experimental-agent-onboarding-modal" role="dialog" aria-modal="true" aria-label={t("agents.onboarding.dialogLabel", "AI Interview")}>
        <div className="modal-header">
          <h3>{t("agents.onboarding.title", "AI Interview")}</h3>
          <button className="modal-close" onClick={() => void handleClose()} aria-label={t("common.closeAriaLabel", "Close")}>×</button>
        </div>

        {history.length > 0 && <ConversationHistory entries={history} />}

        {viewState === "initial" && (
          <div className="form-group">
            <label htmlFor="agent-onboarding-intent">{isEditMode ? t("agents.onboarding.intentLabelEdit", "What should this agent change or improve?") : t("agents.onboarding.intentLabelCreate", "What should this new agent own?")}</label>
            <textarea id="agent-onboarding-intent" className="input experimental-agent-onboarding-modal__textarea" value={intent} onChange={(e) => setIntent(e.target.value)} />
            <div className="modal-actions">
              <button className="btn" onClick={() => void handleClose()}>{t("common.cancel", "Cancel")}</button>
              <button className="btn btn-primary" disabled={!intent.trim()} onClick={() => void start()}>{isEditMode ? t("agents.onboarding.startInterview", "Start interview") : t("agents.onboarding.startOnboarding", "Start onboarding")}</button>
            </div>
          </div>
        )}

        {(viewState === "loading" || viewState === "question") && (
          <div className="form-group">
            <label htmlFor="agent-onboarding-answer">{currentQuestion || t("agents.onboarding.thinking", "Thinking...")}</label>
            <textarea id="agent-onboarding-answer" className="input experimental-agent-onboarding-modal__textarea" value={answer} onChange={(e) => setAnswer(e.target.value)} />
            <div className="modal-actions">
              <button className="btn" onClick={() => void handleClose()}>{t("common.cancel", "Cancel")}</button>
              <button className="btn btn-primary" disabled={viewState === "loading" || !answer.trim()} onClick={() => void submitAnswer()}>{t("agents.onboarding.continue", "Continue")}</button>
            </div>
          </div>
        )}

        {viewState === "summary" && summary && (
          <div className="form-group">
            <label>{isEditMode ? t("agents.onboarding.updatedDraftReady", "Updated draft ready for review") : t("agents.onboarding.draftReady", "Draft ready for review")}</label>
            <p className="experimental-agent-onboarding-modal__summary-intro">
              {t("agents.onboarding.draftIntro", "Review this generated draft. Nothing is applied until you confirm.")}
            </p>
            <div className="experimental-agent-onboarding-modal__summary card">
              <div className="experimental-agent-onboarding-modal__summary-section">
                <h4>{t("agents.onboarding.sectionIdentity", "Identity")}</h4>
                <dl className="experimental-agent-onboarding-modal__summary-list">
                  <div><dt>{t("agents.onboarding.fieldName", "Name")}</dt><dd>{renderSummaryValue(summary.name)}</dd></div>
                  <div><dt>{t("agents.onboarding.fieldRole", "Role")}</dt><dd>{renderSummaryValue(summary.role)}</dd></div>
                  <div><dt>{t("agents.onboarding.fieldTitle", "Title")}</dt><dd>{renderSummaryValue(summary.title)}</dd></div>
                  <div><dt>{t("agents.onboarding.fieldIcon", "Icon")}</dt><dd>{renderSummaryValue(summary.icon)}</dd></div>
                  <div><dt>{t("agents.onboarding.fieldReportsTo", "Reports To")}</dt><dd>{renderSummaryValue(summary.reportsTo)}</dd></div>
                </dl>
              </div>

              <div className="experimental-agent-onboarding-modal__summary-section">
                <h4>{t("agents.onboarding.sectionConfiguration", "Configuration")}</h4>
                <dl className="experimental-agent-onboarding-modal__summary-list">
                  <div><dt>{t("agents.onboarding.fieldInlineInstructions", "Inline Instructions")}</dt><dd className="experimental-agent-onboarding-modal__summary-block">{renderSummaryValue(summary.instructionsText)}</dd></div>
                  <div><dt>{t("agents.onboarding.fieldSoul", "Soul")}</dt><dd className="experimental-agent-onboarding-modal__summary-block">{renderSummaryValue(summary.soul)}</dd></div>
                  <div><dt>{t("agents.onboarding.fieldAgentMemory", "Agent Memory")}</dt><dd className="experimental-agent-onboarding-modal__summary-block">{renderSummaryValue(summary.memory)}</dd></div>
                  <div><dt>{t("agents.onboarding.fieldSkills", "Skills")}</dt><dd>{renderSummaryValue(summary.skills?.join(", "))}</dd></div>
                  <div><dt>{t("agents.onboarding.fieldThinkingLevel", "Thinking Level")}</dt><dd>{renderSummaryValue(summary.thinkingLevel)}</dd></div>
                  <div><dt>{t("agents.onboarding.fieldMaxTurns", "Max Turns")}</dt><dd>{renderSummaryValue(summary.maxTurns)}</dd></div>
                  <div><dt>{t("agents.onboarding.fieldTemplate", "Template")}</dt><dd>{renderSummaryValue(summary.templateId)}</dd></div>
                  <div><dt>{t("agents.onboarding.fieldPatternAgent", "Pattern Agent")}</dt><dd>{renderSummaryValue(summary.patternAgentId)}</dd></div>
                </dl>
              </div>

              {(summary.heartbeatProcedurePath || summary.heartbeatIntervalMs || summary.heartbeatEnabled !== undefined || summary.modelHint || summary.runtimeHint) && (
                <div className="experimental-agent-onboarding-modal__summary-section">
                  <h4>{t("agents.onboarding.sectionRuntimeHints", "Runtime Hints")}</h4>
                  <dl className="experimental-agent-onboarding-modal__summary-list">
                    <div><dt>{t("agents.onboarding.fieldHeartbeatPath", "Heartbeat Procedure Path")}</dt><dd>{renderSummaryValue(summary.heartbeatProcedurePath)}</dd></div>
                    <div><dt>{t("agents.onboarding.fieldHeartbeatInterval", "Heartbeat Interval")}</dt><dd>{renderSummaryValue(summary.heartbeatIntervalMs ? `${summary.heartbeatIntervalMs}ms` : undefined)}</dd></div>
                    <div><dt>{t("agents.onboarding.fieldHeartbeatEnabled", "Heartbeat Enabled")}</dt><dd>{renderSummaryValue(summary.heartbeatEnabled === undefined ? undefined : summary.heartbeatEnabled ? t("agents.onboarding.yes", "yes") : t("agents.onboarding.no", "no"))}</dd></div>
                    <div><dt>{t("agents.onboarding.fieldModelHint", "Model Hint")}</dt><dd>{renderSummaryValue(summary.modelHint)}</dd></div>
                    <div><dt>{t("agents.onboarding.fieldRuntimeHint", "Runtime Hint")}</dt><dd>{renderSummaryValue(summary.runtimeHint)}</dd></div>
                  </dl>
                </div>
              )}

              {summary.rationale && (
                <div className="experimental-agent-onboarding-modal__summary-section">
                  <h4>{t("agents.onboarding.sectionRationale", "Rationale")}</h4>
                  <p className="experimental-agent-onboarding-modal__summary-block">{summary.rationale}</p>
                </div>
              )}
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => void handleClose()}>{t("common.cancel", "Cancel")}</button>
              <button className="btn btn-primary" onClick={() => void handleConfirmDraft()}>{isEditMode ? t("agents.onboarding.applyDraftSettings", "Apply draft to settings form") : t("agents.onboarding.applyDraftAgent", "Apply draft to agent form")}</button>
            </div>
          </div>
        )}

        {viewState === "error" && error && (
          <div className="form-group">
            <div className="form-error">{error}</div>
            <div className="modal-actions">
              <button className="btn" onClick={() => void handleClose()}>{t("common.close", "Close")}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
