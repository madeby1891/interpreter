# workers/api

Edge API for 1891 Interpreter. Two jobs today:

1. **CORS proxy** for the Apps Script web app, so the marketing site and the
   `/app/*` pages can read JSON responses cross-origin instead of falling back
   to JSONP for every read.
2. **Live job board fan-out.** A per-tenant Durable Object (`JobBoardRoom`)
   accepts WebSocket and Server-Sent Events subscribers; the Apps Script
   web app `POST`s to `/v1/notify/job` whenever a job is created, claimed, or
   cancelled, and the DO pushes the event to every subscriber in that tenant.

## Layout

```
src/
  index.ts                 Router / entrypoint
  cors.ts                  CORS helpers, single allowed origin + dev fallback
  jwt.ts                   HS256 compact JWT — matches the Apps Script format
  proxy.ts                 Forward to Apps Script, follow redirects, rewrap
  sse.ts                   Server-Sent Events framing helper
  durable/
    JobBoardRoom.ts        Per-tenant DO that holds subscriber connections
tests/
  cors.test.ts             vitest unit tests for cors / jwt / proxy
wrangler.toml              Worker config + DO binding + non-secret vars
tsconfig.json
package.json
```

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| `OPTIONS` | `*` | CORS preflight |
| `GET` | `/` and `/health` | Health probe |
| `GET`/`POST` | `/v1/proxy/*` | Forward to Apps Script web app, return JSON with CORS |
| `GET`/`POST` | `/interpreter-api/*` | Same as `/v1/proxy/*` (legacy prefix while subdomain is provisioned) |
| `GET` | `/v1/jobs/stream?session=<jwt>` | SSE subscribe to the tenant's job board |
| `GET` | `/v1/jobs/ws?session=<jwt>` | WebSocket subscribe to the tenant's job board |
| `POST` | `/v1/notify/job` | Apps Script → Worker server-to-server publish hook |

The `session` JWT is verified against `JWT_SECRET` (must equal the
`HMAC_SECRET` stored in the Apps Script `PropertiesService`). Tenant id is
read from the JWT payload (`tid`); subscribers are joined to the
`tenant:<tid>` room.

The `/v1/notify/job` hook authenticates with either:

- `X-1891-Secret: <JWT_SECRET>` (simpler — Apps Script already knows the value), or
- `Authorization: Bearer <jwt>` signed with the same secret.

## Deploy

From `workers/api/`:

```bash
# 1. Install
npm install

# 2. Lint + tests
npm test
npx tsc --noEmit

# 3. Push the secret (one-time, value = the Apps Script HMAC_SECRET property)
npx wrangler secret put JWT_SECRET

# 4. Deploy
npx wrangler deploy
```

`wrangler deploy` prints a URL like
`https://1891-interpreter-api.<account>.workers.dev`. Until the
`api.madeby1891.com` custom domain is provisioned in Cloudflare, use that URL.

## Wire the client

After deploy, edit `site/assets/js/api.js` and change `ENDPOINT`:

```js
// before
var ENDPOINT = 'https://script.google.com/macros/s/AKfycbwjHVtZ3un9qcA0XOaXsU0EDpk_Dbinsk_UKwKf8DicxkbKWaCdEys7MlcR0pdGDhu0HA/exec';

// after (paste the URL wrangler printed; keep the /v1/proxy suffix)
var ENDPOINT = 'https://1891-interpreter-api.<account>.workers.dev/v1/proxy';
```

The Worker accepts the same `action=...` query strings and `URLSearchParams`
bodies the Apps Script does today, so once `ENDPOINT` is swapped the JSONP
fallback in `api.js` can be removed in a follow-up.

To subscribe to the live job board from the page:

```js
const es = new EventSource(`https://1891-interpreter-api.<account>.workers.dev/v1/jobs/stream?session=${encodeURIComponent(IntApi.getSession())}`);
es.addEventListener("job", (ev) => { const payload = JSON.parse(ev.data); /* render */ });
```

## Environment variables

| Name | Where | Notes |
| --- | --- | --- |
| `APPS_SCRIPT_URL` | `wrangler.toml [vars]` | Apps Script `/exec` URL — fine to commit |
| `ALLOWED_ORIGIN` | `wrangler.toml [vars]` | `https://madeby1891.com` |
| `JWT_SECRET` | `wrangler secret put` | Must match `HMAC_SECRET` in the Apps Script project properties |

## Notes

- This Worker is the v1 step toward `workers/api` as described in
  `docs/A_architecture.md` §A4. It is intentionally narrow — no Sheet RPC,
  no R2 signing, no audit log writes yet. Those land alongside `workers/sync`.
- The DO does not persist subscriber state. A DO restart drops live
  connections; clients should reconnect with exponential backoff. EventSource
  does this for free.
