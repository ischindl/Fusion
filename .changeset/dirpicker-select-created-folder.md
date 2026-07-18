---
"@runfusion/fusion": patch
---

summary: Creating a new folder in project setup now selects it fully — the browser panel follows the created folder so Select confirms it.
category: fix
dev: "DirectoryPicker: with selectCreatedDirectory, handleCreateFolder now navigates the browse panel into the created directory instead of refreshing the parent; the footer Select button commits browser.currentPath, so staying on the parent let the next click overwrite the auto-selected new folder."
