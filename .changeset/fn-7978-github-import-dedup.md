---
"@runfusion/fusion": patch
---

summary: GitHub import skips prior issues after description edits or owner/repo casing changes.
category: fix
dev: Consolidated GitHub import dedup into shared isGitHubIssueAlreadyImported/buildGitHubIssueSource (sourceIssue-first, case-insensitive repository, source.sourceMetadata and description-URL fallbacks) used by both CLI import functions (runTaskImportGitHubInteractive and runTaskImportFromGitHub, now listing with slim:false), both extension tools, and dashboard single/batch routes; removed the description Source-URL-regex-only importedUrls dedup.
