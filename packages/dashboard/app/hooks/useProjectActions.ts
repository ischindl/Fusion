import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { pauseProject, resumeProject, setProjectRuntime, unregisterProject } from "../api";
import type { ProjectInfo } from "../api";
import { replaceProjectIdInUrl } from "../utils/projectUrlState";
import type { ViewMode, TaskView } from "./useViewState";
import type { ToastType } from "./useToast";
import type { OnboardingCompletionOutcome } from "../components/ModelOnboardingModal";

interface UseProjectActionsOptions {
  setCurrentProject: (project: ProjectInfo) => void;
  clearCurrentProject: () => void;
  setViewMode: (mode: ViewMode) => void;
  setTaskView: (view: TaskView) => void;
  currentProject: ProjectInfo | null;
  refreshProjects: () => Promise<void>;
  toggleFavoriteProvider: (provider: string) => Promise<void>;
  toggleFavoriteModel: (modelId: string) => Promise<void>;
  addToast: (message: string, type: ToastType) => void;
  openSettings: () => void;
  openSetupWizard: () => void;
  closeSetupWizard: () => void;
  closeModelOnboarding: () => void;
  /*
  FNXC:GithubStarAsk 2026-08-19-03:59:
  Fired once onboarding is FINISHED (not dismissed) so the dashboard can make its one post-onboarding
  ask — currently the GitHub star prompt. The prompt owns its own "already asked" state; this hook
  only reports the moment.
  */
  onOnboardingCompleted?: () => void;
  /*
  FNXC:ProjectSwitchModalReset 2026-07-23-00:00:
  Every project-switch entry point (select, view-all, setup-complete) must dismiss
  modals scoped to the previous project so its task detail / planning payloads do not
  render over the newly selected project.
  */
  closeProjectScopedModals: () => void;
  /** Guard project-scope destruction before any URL, project, view, or modal mutation. */
  requestCloseProjectScopedUi?: () => boolean | Promise<boolean>;
}

export interface UseProjectActionsResult {
  handleSelectProject: (project: ProjectInfo) => Promise<boolean>;
  handleViewAllProjects: () => Promise<boolean>;
  handleOpenSettings: () => void;
  handleAddProject: () => void;
  handleSetupComplete: (project: ProjectInfo) => Promise<boolean>;
  handleModelOnboardingComplete: (outcome?: OnboardingCompletionOutcome) => void;
  handlePauseProject: (project: ProjectInfo) => Promise<void>;
  handleResumeProject: (project: ProjectInfo) => Promise<void>;
  /**
   * FNXC:ProjectRuntimeOff 2026-11-07-17:41 (RUFU-871):
   * Writes a project's engine-runtime switch from the project card. Distinct from
   * `handleResumeProject`: resume starts a PAUSED project row, this one loads or unloads the engine
   * runtime, and the two are different switches on the same card.
   *
   * FNXC:ProjectRuntimeOff 2026-11-07-20:31 (RUFU-871):
   * `enabled` carries the DESIRED state, so the card's toggle has one owner for the request instead of
   * a second disable pipeline beside this one. `false` unloads the runtime — the engine stops working on
   * the project from the next pass, an in-flight pass finishes, nothing is aborted, and board/cards/
   * history remain readable; it never touches `status`. The parameter is optional and defaults to `true`
   * only so pre-toggle hosts keep their meaning; the card always passes it explicitly. The
   * `handleEnableProjectRuntime` spelling stays because the host-side prop names live outside this
   * slice's file scope.
   */
  handleEnableProjectRuntime: (project: ProjectInfo, enabled?: boolean) => Promise<void>;
  handleRemoveProject: (project: ProjectInfo) => Promise<void>;
  handleToggleFavorite: (provider: string) => Promise<void>;
  handleToggleModelFavorite: (modelId: string) => Promise<void>;
}

export function useProjectActions(options: UseProjectActionsOptions): UseProjectActionsResult {
  const { t } = useTranslation("app");
  const {
    setCurrentProject,
    clearCurrentProject,
    setViewMode,
    setTaskView,
    currentProject,
    refreshProjects,
    toggleFavoriteProvider,
    toggleFavoriteModel,
    addToast,
    openSettings,
    openSetupWizard,
    closeSetupWizard,
    closeModelOnboarding,
    closeProjectScopedModals,
    onOnboardingCompleted,
    requestCloseProjectScopedUi,
  } = options;

  const handleSelectProject = useCallback(async (project: ProjectInfo) => {
    /*
    FNXC:DesktopViewWindows 2026-09-11-19:35:
    A project boundary must await the shared destructive-close verdict before changing URL, project, view, or scoped modal state. Re-selecting the current project remains a synchronous-effect-free success.
    */
    if (project.id === currentProject?.id) return true;
    if (requestCloseProjectScopedUi && !await requestCloseProjectScopedUi()) return false;
    closeProjectScopedModals();
    replaceProjectIdInUrl(project.id);
    setCurrentProject(project);
    setViewMode("project");
    return true;
  }, [closeProjectScopedModals, currentProject?.id, requestCloseProjectScopedUi, setCurrentProject, setViewMode]);

  const handleViewAllProjects = useCallback(async () => {
    if (requestCloseProjectScopedUi && !await requestCloseProjectScopedUi()) return false;
    closeProjectScopedModals();
    replaceProjectIdInUrl(null);
    clearCurrentProject();
    setViewMode("overview");
    setTaskView("command-center");
    return true;
  }, [clearCurrentProject, closeProjectScopedModals, requestCloseProjectScopedUi, setViewMode, setTaskView]);

  const handleOpenSettings = useCallback(() => {
    openSettings();
  }, [openSettings]);

  const handleAddProject = useCallback(() => {
    openSetupWizard();
  }, [openSetupWizard]);

  const handleSetupComplete = useCallback(async (project: ProjectInfo) => {
    if (project.id !== currentProject?.id && requestCloseProjectScopedUi && !await requestCloseProjectScopedUi()) return false;
    closeSetupWizard();
    if (project.id !== currentProject?.id) closeProjectScopedModals();
    replaceProjectIdInUrl(project.id);
    setCurrentProject(project);
    setViewMode("project");
    addToast(t("projects.setup.success", "Project {{name}} registered successfully", { name: project.name }), "success");
    void refreshProjects();
    return true;
  }, [closeSetupWizard, closeProjectScopedModals, currentProject?.id, requestCloseProjectScopedUi, setCurrentProject, setViewMode, addToast, refreshProjects, t]);

  const handleModelOnboardingComplete = useCallback((outcome?: OnboardingCompletionOutcome) => {
    closeModelOnboarding();
    // FNXC:GithubStarAsk 2026-08-19-03:59: only a finished onboarding earns the star ask; a dismissal does not.
    if (outcome !== "dismissed") onOnboardingCompleted?.();
  }, [closeModelOnboarding, onOnboardingCompleted]);

  const handlePauseProject = useCallback(async (project: ProjectInfo) => {
    try {
      await pauseProject(project.id);
      addToast(t("projects.actions.pauseSuccess", "Project {{name}} paused", { name: project.name }), "success");
      await refreshProjects();
    } catch {
      addToast(t("projects.actions.pauseError", "Failed to pause project {{name}}", { name: project.name }), "error");
    }
  }, [addToast, refreshProjects, t]);

  const handleResumeProject = useCallback(async (project: ProjectInfo) => {
    try {
      await resumeProject(project.id);
      addToast(t("projects.actions.resumeSuccess", "Project {{name}} resumed", { name: project.name }), "success");
      await refreshProjects();
    } catch {
      addToast(t("projects.actions.resumeError", "Failed to resume project {{name}}", { name: project.name }), "error");
    }
  }, [addToast, refreshProjects, t]);

  /*
  FNXC:ProjectRuntimeOff 2026-11-07-17:41 (RUFU-871):
  Turning the runtime has to be reflected where the operator read the state, so the switch is followed
  by the same awaited `refreshProjects()` the pause/resume actions use — the card and the combo
  re-render from the fresh projection instead of waiting for a page reload.

  FNXC:ProjectRuntimeOff 2026-11-07-20:31 (RUFU-871):
  Both directions now come through here. The success copy for the off direction states what actually
  happens (engine work stops from the next pass, nothing is aborted, the board stays readable) because
  the operator-facing alternative — a bare "turned off" — reads like the project was deleted or paused,
  which it was not: `status` is a different axis and this call never writes it.
  */
  const handleEnableProjectRuntime = useCallback(async (project: ProjectInfo, enabled = true) => {
    try {
      await setProjectRuntime(project.id, enabled, "project-card");
      addToast(
        enabled
          ? t("projects.actions.runtimeOnSuccess", "Project {{name}} runtime turned on", { name: project.name })
          : t("projects.actions.runtimeOffSuccess", "Project {{name}} runtime turned off — the engine stops working on it from the next pass; the board, cards and history stay readable", { name: project.name }),
        "success",
      );
      await refreshProjects();
    } catch {
      addToast(
        enabled
          ? t("projects.actions.runtimeOnError", "Failed to turn on the runtime of project {{name}}", { name: project.name })
          : t("projects.actions.runtimeOffError", "Failed to turn off the runtime of project {{name}}", { name: project.name }),
        "error",
      );
    }
  }, [addToast, refreshProjects, t]);

  const handleRemoveProject = useCallback(async (project: ProjectInfo) => {
    try {
      if (currentProject?.id === project.id && requestCloseProjectScopedUi && !await requestCloseProjectScopedUi()) return;
      await unregisterProject(project.id);
      addToast(t("projects.actions.removeSuccess", "Project {{name}} removed", { name: project.name }), "success");

      if (currentProject?.id === project.id) {
        replaceProjectIdInUrl(null);
        clearCurrentProject();
        setViewMode("overview");
      }

      await refreshProjects();
    } catch {
      addToast(t("projects.actions.removeError", "Failed to remove project {{name}}", { name: project.name }), "error");
    }
  }, [currentProject, requestCloseProjectScopedUi, clearCurrentProject, setViewMode, addToast, refreshProjects, t]);

  const handleToggleFavorite = useCallback(async (provider: string) => {
    try {
      await toggleFavoriteProvider(provider);
    } catch {
      addToast(t("projects.actions.favoritesError", "Failed to update favorites"), "error");
    }
  }, [toggleFavoriteProvider, addToast, t]);

  const handleToggleModelFavorite = useCallback(async (modelId: string) => {
    try {
      await toggleFavoriteModel(modelId);
    } catch {
      addToast(t("projects.actions.modelFavoritesError", "Failed to update model favorites"), "error");
    }
  }, [toggleFavoriteModel, addToast, t]);

  return {
    handleSelectProject,
    handleViewAllProjects,
    handleOpenSettings,
    handleAddProject,
    handleSetupComplete,
    handleModelOnboardingComplete,
    handlePauseProject,
    handleResumeProject,
    handleEnableProjectRuntime,
    handleRemoveProject,
    handleToggleFavorite,
    handleToggleModelFavorite,
  };
}
