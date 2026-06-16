---
"@runfusion/fusion": minor
---

Add a persistent, incrementally-refreshed knowledge index (U14) downstream agents can query.

- **Schema** — new `knowledge_pages` SQLite table (`packages/core/src/db.ts`) with `SCHEMA_VERSION` bumped 118 → 119 (added in the same change as the migration; the fingerprint auto-covers SCHEMA_SQL tables). Keyword search uses a denormalized lowercased `searchText` column with AND-of-terms `LIKE` matching, deliberately avoiding SQLite FTS5 (not available on every build) and any external embedding API.
- **Index module** (`packages/dashboard/src/knowledge-index.ts`) — upsert-by-source-key pages, a model-free keyword query API, and `refreshKnowledgeForTask` that re-indexes a single completed task (one upsert, never a full re-index, so unaffected pages keep their timestamps). This is the delta over the existing `insights`/`memoryView` surfaces, which are LLM-extracted learnings, not a deterministic searchable index of concrete task/PR history.
- **Refresh hook** — `KnowledgeIndexRefreshService` listens for `task:moved → done` (mirroring `GitHubSourceIssueCloseService`) and is wired alongside the other completion listeners; fail-soft so it can never disrupt task completion.
- **Query API** (`register-knowledge-routes.ts`) — `GET /api/knowledge/query` and `POST /api/knowledge/refresh`, registered as an `ApiRouteRegistrar` so they inherit the dashboard's standard session/auth middleware (401 when unauthenticated) and apply `getScopedStore(req)` (no cross-project reads), exactly like U9.
