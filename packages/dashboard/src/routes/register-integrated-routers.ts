import type { Router } from "express";
import type { TaskStore } from "@fusion/core";
import type { ServerOptions } from "../server.js";
import { createMissionRouter } from "../mission-routes.js";
import { createInsightsRouter } from "../insights-routes.js";
import { createEvalsRouter } from "../evals-routes.js";
import { createResearchRouter } from "../research-routes.js";
import { createTodoRouter } from "../todo-routes.js";
import { createRoadmapCompatibilityRouter } from "../roadmap-routes.js";
import { createDevServerRouter } from "../dev-server-routes.js";
import type { AiSessionStore } from "../ai-session-store.js";
import { createStashRecoveryRouter } from "./register-stash-recovery-routes.js";

interface IntegratedRoutersOptions {
  router: Router;
  store: TaskStore;
  options?: ServerOptions;
  aiSessionStore?: AiSessionStore;
}

interface DevServerRouterOptions {
  router: Router;
  store: TaskStore;
}

export function registerIntegratedRouters({
  router,
  store,
  options,
  aiSessionStore,
}: IntegratedRoutersOptions): void {
  router.use(
    "/missions",
    createMissionRouter(store, options?.missionAutopilot, aiSessionStore, options?.missionExecutionLoop, options?.engineManager),
  );

  router.use("/insights", createInsightsRouter(store));
  router.use("/evals", createEvalsRouter(store));
  router.use("/research", createResearchRouter(store));
  router.use("/todos", createTodoRouter(store));
  router.use("/roadmaps", createRoadmapCompatibilityRouter(store));
  router.use("/stash-recovery", createStashRecoveryRouter(store));
}

export function registerIntegratedDevServerRouter({ router, store }: DevServerRouterOptions): void {
  const devServerRouter = createDevServerRouter({
    projectRoot: store.getRootDir(),
  });
  router.use("/dev-server", devServerRouter);
}
