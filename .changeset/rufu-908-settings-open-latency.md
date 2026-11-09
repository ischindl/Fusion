---
"@runfusion/fusion": patch
---

summary: Open Settings faster by removing two serial database reads from its load path.
category: performance
dev: `GET /api/settings/scopes` starts the `workflow_settings` read together with the scoped-settings read, and `getSettingsFast`/`getSettingsByScopeFast` start the secrets sync-passphrase probe together with the two settings reads. Response shapes, key order and error precedence are unchanged; the boot-path `getSettings`/`getSettingsByScope` keep their original order.
