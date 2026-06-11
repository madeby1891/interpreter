/**
 * interpreter-data tests — runs INSIDE workerd via @cloudflare/vitest-pool-workers,
 * against a real (local, throwaway) D1 with migrations/0001_init.sql applied.
 *
 * This is the "dual-write proven in test" harness PERSISTENCE_ARCHITECTURE.md
 * (ADR-001 §6) asks for: the same writeRow/deleteRow/HMAC-envelope code that
 * runs in production executes here against a real SQLite-backed D1 — no mocks
 * of the data layer. Synthetic fixtures ONLY (SECURITY_BASELINE.md: never real
 * PII/PHI in the repo; emails use RFC 2606 reserved domains).
 *
 * Bindings are declared here directly instead of pointing at wrangler.toml so
 * the prod config (queues, cron, real database_id) stays untouched by tests.
 */
import path from 'node:path';
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, 'migrations'));
  return {
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
      poolOptions: {
        workers: {
          singleWorker: true,
          miniflare: {
            compatibilityDate: '2024-09-23',
            compatibilityFlags: ['nodejs_compat'],
            d1Databases: { DB: 'interpreter-data-test' },
            kvNamespaces: ['CACHE'],
            bindings: {
              PRODUCT: 'interpreter',
              DEFAULT_TENANT: 'host',
              // Test-only secret — NOT the production HMAC_SECRET (that lives in
              // Worker secrets / the gitignored d1-secret.gs, never in the repo).
              HMAC_SECRET: 'test-hmac-secret-synthetic',
              TEST_MIGRATIONS: migrations,
            },
          },
        },
      },
    },
  };
});
