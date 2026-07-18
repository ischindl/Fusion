/*
 * FNXC:PostgresSchema 2026-07-18-11:00:
 * Version 0019 fixes integer overflow for columns that can hold values
 * exceeding PostgreSQL's 32-bit INTEGER range (max ~2.1 billion).
 * SQLite stores all integer types as 64-bit, so token counts and
 * cumulative execution time in milliseconds can legitimately exceed 2^31-1.
 *
 * Affected columns (project.tasks):
 *   token_usage_input_tokens       → bigint
 *   token_usage_output_tokens      → bigint
 *   token_usage_cached_tokens      → bigint
 *   token_usage_cache_write_tokens → bigint
 *   token_usage_total_tokens       → bigint
 *   cumulative_active_ms           → bigint
 *
 * ALTER COLUMN ... TYPE bigint is safe because bigint's domain includes all
 * valid integer values; no data loss occurs.
 */
ALTER TABLE project.tasks ALTER COLUMN token_usage_input_tokens TYPE bigint;
ALTER TABLE project.tasks ALTER COLUMN token_usage_output_tokens TYPE bigint;
ALTER TABLE project.tasks ALTER COLUMN token_usage_cached_tokens TYPE bigint;
ALTER TABLE project.tasks ALTER COLUMN token_usage_cache_write_tokens TYPE bigint;
ALTER TABLE project.tasks ALTER COLUMN token_usage_total_tokens TYPE bigint;
ALTER TABLE project.tasks ALTER COLUMN cumulative_active_ms TYPE bigint;
