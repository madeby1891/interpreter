import type { Env } from '../src/db';

declare module 'cloudflare:test' {
  // ProvidedEnv is what `import { env } from 'cloudflare:test'` returns.
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}
