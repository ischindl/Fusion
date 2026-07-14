---
"@runfusion/fusion": patch
---

summary: CLI agent tools now boot PostgreSQL instead of the removed SQLite runtime.
category: fix
dev: The extension's getStore(cwd) path constructed a legacy SQLite TaskStore (runtime removed under VAL-REMOVAL-005), and the fn_agent_* tools constructed AgentStore without an asyncLayer — both threw "SQLite Database class body has been removed" in PG mode. getStore now routes through createTaskStoreForBackend (mirroring fn serve) and caches the boot result for deterministic shutdown; a new getAgentStore(cwd) helper injects the project store's asyncLayer into AgentStore so agent data lives in PostgreSQL. CLI extension tests were migrated to a shared PG harness (pg-extension-harness.ts) backed by an isolated test database with a test-only store-injection hook (__setCachedStoreForTesting).
