import { definePlugin } from "@fusion/plugin-sdk";
import { createCliPrintingPressRoutes } from "./routes/wizard-routes.js";
import { ensureCliPressSchema } from "./store/cli-press-store.js";

const plugin = definePlugin({
  manifest: {
    id: "fusion-plugin-cli-printing-press",
    name: "CLI Printing Press",
    version: "0.1.0",
    description: "Guided wizard for drafting external service CLI definitions",
  },
  state: "installed",
  hooks: {
    onSchemaInit: ensureCliPressSchema,
  },
  routes: createCliPrintingPressRoutes(),
  dashboardViews: [
    {
      viewId: "wizard",
      label: "Create Service CLI",
      componentPath: "./dashboard-view",
      icon: "Wand2",
      placement: "primary",
      order: 60,
    },
    {
      viewId: "manage",
      label: "Manage Service CLIs",
      componentPath: "./manage-view",
      icon: "List",
      placement: "primary",
      order: 61,
    },
  ],
});

export default plugin;
export { CliPrintingPressWizardView } from "./dashboard-view.js";
export { CliPrintingPressManageView } from "./manage-view.js";
export { CliPrintingPressTestRunner } from "./run/TestRunnerPanel.js";
export { createCliPressStore, ensureCliPressSchema } from "./store/cli-press-store.js";
export * from "./store/cli-press-types.js";
