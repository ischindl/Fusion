---
"@runfusion/fusion": minor
---

summary: Add a Hide imported toggle that filters imported issues, PRs, and GitLab items from Import Tasks.
category: feature
dev: GitHubImportModal renders a persisted per-project hideImported toggle in the list-pane header (and the GitLab toolbar/header); when on, imported rows (importedUrls predicate) are excluded from the issues/pulls/GitLab render sets while the "{n} imported" count still reflects the full fetched set, with a dedicated all-imported empty state. Toggle persists via GitHubImportPersistedState.hideImported.
