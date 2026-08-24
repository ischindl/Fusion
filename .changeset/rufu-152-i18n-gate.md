---
"@runfusion/fusion": patch
---

summary: Restore the i18n parity gate and localize artifact preview and AI merge review copy in all locales.
category: fix
dev: Syncs the settings.jira parity keys into the six secondary catalogs (empty values), registers documents.closeArtifactPreview / documents.loadingImageArtifact plus the five taskDetail.aiMergeReviewReconciliation.* keys in all seven locales, and routes the ArtifactImageViewer and TaskDetailModal reconciliation copy through the app namespace. The i18n lint baseline test is budgeted at 30s per test and the migrated copy is pinned by component regressions. (RUFU-152)
