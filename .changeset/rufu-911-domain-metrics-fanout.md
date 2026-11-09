---
"@runfusion/fusion": patch
---

summary: Dashboard metrics now count every served project, not just one.
category: fix
dev: The `/metrics` domain sampler enumerated only the secondary project-store cache, so `fusion_domain_projects_total` under-reported the fleet and `fusion_domain_postgres_queries_per_second` could sit at 0. It now unions every already-open store (engine-manager, registered, default).
