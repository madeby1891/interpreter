// Applies migrations/0001_init.sql to the throwaway test D1 before each test
// file runs (vitest-pool-workers re-runs setup inside each isolated storage
// snapshot, so every test starts from a clean, fully-migrated schema).
import { applyD1Migrations, env } from 'cloudflare:test';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
