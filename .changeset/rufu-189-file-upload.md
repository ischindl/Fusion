---
"@runfusion/fusion": minor
---

summary: Upload files into any folder from the Files browser, with per-file results and confirmed replace.
category: feature
dev: Adds `POST /api/files/upload` (multipart; 25 MiB per-file cap `MAX_UPLOAD_FILE_SIZE`, 20 files per request, safe-by-default `EEXIST` unless `overwrite=true`) and the `uploadWorkspaceFiles` client helper. The Settings file pickers deliberately do not enable the new `allowUpload` affordance.
