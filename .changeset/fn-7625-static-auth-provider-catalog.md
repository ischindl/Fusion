---
"@runfusion/fusion": patch
---

summary: Authentication settings always lists all supported providers, regardless of connected runtime plugins.
category: fix
dev: GET /api/auth/status now enumerates a static supported-provider catalog (union with storage-reported providers) and uses runtime/auth state only to annotate per-provider status; connecting a runtime plugin (e.g. Hermes Runtime) no longer collapses the provider list.
