# TRACKING — 1891 Interpreter

**Status:** scoping doc, no code yet.
**Audience:** the coding agent that picks up tracking work for the interpreter project.
**Read first:** `~/Desktop/1891/projects/godview/specs/01_METRICS_BUS_SPEC.md` (pull side), `~/Desktop/1891/shared/specs/EVENT_CAPTURE.md` (write side, in draft), `projects/interpreter/PROJECT_GUIDE.md`, `projects/interpreter/CLAUDE.md`.

---

## 1. Project at a glance

1891 Interpreter is a multi-tenant interpreting-agency platform — scheduling, interpreter app, billing, document translation, live captions — free forever for verified Deaf-owned agencies. Per PRD section A2 the canonical tenant unit is a per-agency Google Sheet plus per-tenant R2 prefix, KV namespace key, and Durable Objects.

**Today (2026-05-17):** spec-only. The full v1 PRD lives under `docs/` (six sections A–F). There is a partial marketing scaffold under `site/assets/` (CSS tokens, vanilla JS for nav + form-stub) but no `site/index.html` yet, no domain registered (`1891interpreter.app` planned), no GitHub repo (`madeby1891/interpreter` planned), no Apps Script project, no Workers, no Sheets. See `HANDOFF.md` for the next-three-actions list.

**When the platform ships:** per-agency tenant model (`tenant_mode: "multi"`), one Apps Script per tenant Sheet, one control-plane Apps Script for the registry, six Workers (`api`, `sync`, `realtime`, `notify`, `translate`, `auth`), per-agency Durable Objects. Tracking must hand the godview an `agency_id`-keyed envelope.

---

## 2. Today vs. when-the-platform-ships

Metric ids fixed per metrics-bus §4. `tenant_id` is `__default` in phase 1, real agency slugs plus `__rollup` in phase 2.

| metric_id | phase 1 — marketing site live, platform not built | phase 2 — platform live, agencies onboarded |
|---|---|---|
| `interpreters_active` | `0` (static) | Per-agency: `Interpreters` tab count where `status='active'`. Rollup sums. |
| `jobs_open` | `0` (static) | Per-agency Durable Object: count of `Jobs` rows where `status in ('posted','offered')`. Rollup sums. |
| `jobs_filled_mtd` | `0` (static) | Per-agency: count of `Jobs` rows where `status='filled'` and `filled_at >= month_start`. Rollup sums. |
| `fill_rate_mtd` | `0` (static) | Per-agency: filled / (filled + canceled + unfilled) for current month. Rollup is job-weighted across agencies. |
| `hours_billed_mtd` | `0` (static) | Per-agency: sum of `Invoices` row `billable_minutes / 60` where `period = current month`. Rollup sums. |

No metric leaks interpreter, requestor, or consumer identity. Per-agency `Audit_Log` (7-year append-only, PRD A6) records the read; godview reads the pre-aggregated value, not the raw rows.

---

## 3. Visitor analytics gaps for the marketing site

This is the only tracking that has a place to live today. Pages don't exist yet beyond the CSS/JS scaffolding — every event below is a gap.

| event_name | live today? | needs | notes |
|---|---|---|---|
| `pageview` | no | beacon on every `site/*.html` page | path + referrer + project_slug. No URL query strings carrying PII. |
| `session_start` | no | beacon, first event of a visit window | cookieless session id rotated per metrics bus / event-capture rules. |
| `outbound_click` | no | delegated click listener | record destination hostname only, not query string. |
| `error` | no | `window.onerror` + `unhandledrejection` hook | message + filename + line; strip any inline user content. |
| `waitlist_signup` `{role}` | no — form is a stub | wire `<form data-form>` submit to beacon | `role` enum: `interpreter`, `agency`, `requester`. Currently `main.js` no-ops and shows a confirmation string; needs a real POST + a beacon event. |
| `pricing_page_view` | no — `/pricing` not built | dedicated beacon on `/pricing` load | distinct from generic `pageview` for the godview pricing-funnel tile. |
| `case_study_view` | n/a today | only fire if/when a case study ships | Per PRD F10 #7, customer logos and case studies stay empty until a customer signs a permission line. Reserve the name; don't fire it. |

All events use the shared beacon defined in `~/Desktop/1891/shared/specs/EVENT_CAPTURE.md`: cookieless, no PII in props, no consent banner needed because no identifier persists across sessions or origins.

---

## 4. Reserved event names for platform launch

These names are reserved now so the shared event registry is stable. **Do not implement in phase 1.** When the platform Workers come up, these are the only event names the interpreter project is allowed to emit without an additions PR to the registry.

| event_name | phase | props (NO PII) | target metric_id |
|---|---|---|---|
| `interpreter_signup` | 2 | `{agency_id}` | feeds `interpreters_active` delta |
| `agency_signup` | 2 | `{plan}` (`free` / `pro` / `enterprise`) | tenant-count rollup (godview org-table) |
| `job_posted` | 2 | `{agency_id, modality, location_region}` | feeds `jobs_open` delta |
| `job_filled` | 2 | `{agency_id, modality, time_to_fill_minutes}` | feeds `jobs_filled_mtd`, `fill_rate_mtd` |
| `job_canceled` | 2 | `{agency_id, reason_code}` | feeds `fill_rate_mtd` denominator |
| `hour_billed` | 2 | `{agency_id, modality, duration_minutes}` | feeds `hours_billed_mtd` |
| `availability_updated` | 2 | `{agency_id}` (count only) | operational signal; not a tile metric |

**Props discipline:**
- No interpreter id, requestor id, consumer id, name, email, phone, address, or DOB ever appears in beacon props.
- `agency_id` is the tenant slug from the control Sheet — never the agency's legal name.
- `modality` is an enum: `asl`, `pt`, `cart`, `spoken_es`, `spoken_zh`, `doc_translate`, etc. New values require a registry PR.
- `location_region` is at the metro / county-cluster grain (e.g. `dc-metro`, `frederick-md`). Never street, never venue, never room.
- `reason_code` is an enum (`requestor_canceled`, `no_interpreter_match`, `weather`, `consumer_no_show`, etc.). Free text is not allowed in props.
- `time_to_fill_minutes` and `duration_minutes` are integers. Round to the nearest minute to avoid timing fingerprints.

Per `CLAUDE.md` this project never puts PHI on the beacon. The beacon is for product analytics, not the operational record — that lives in the per-agency Sheet + R2.

---

## 5. Stub godview endpoint

Metrics bus §8 assigns interpreter to **Pattern C** (static JSON drop, 20 min) with a stub `godview.json` checked into `site/` until the control-plane Apps Script ships. The godview Worker fetches this URL on every dashboard load and signs reads via HMAC with a 24-hour timestamp window (longer window than the live Pattern A/B endpoints because the build timestamp is fixed at deploy).

**Exact path:** `site/godview.json` in the repo → `https://1891interpreter.app/godview.json` after first deploy. Registry entry pins this URL.

**Exact envelope:** schema-version 1.0, `project: "interpreter"`, `tenant_mode: "single"` for the stub, `tenants.__default` carrying `status: "ok"` and `value: 0` for all five metric ids (`interpreters_active`, `jobs_open`, `jobs_filled_mtd`, `fill_rate_mtd`, `hours_billed_mtd`). `links.impersonate` points at the marketing home until the agent portal exists.

**Signing approach:** Pattern C says the build script signs the file at build time. For interpreter, this is `_build/build_godview_json.py` (to be created alongside the file) using `GODVIEW_SHARED_SECRET_INTERPRETER` from `~/.config/1891/secrets.env` (gitignored). The build writes the unsigned JSON plus an adjacent `godview.json.sig` containing `hex(HMAC-SHA256(secret, canonical_bytes))` and the build-time `ts`. The godview Worker reads both, verifies the signature, and tolerates a 24-hour age per metrics bus §2 Pattern C.

**Why it ships before the platform:** without this file, the godview tile renders the synthesized error envelope from metrics bus §5 (the dim "stale-with-warning" state). Anthony wants the interpreter tile to read **"0 — stubbed"** on day one, not **"fetch_timeout"**. A zero is a fact ("the platform hasn't onboarded an agency yet"); an error is noise.

When the control-plane Apps Script ships, the registry entry flips from Pattern C (static URL) to Pattern A (Apps Script `?godview=1`), `tenant_mode` flips to `"multi"`, and `tenants` gains per-agency keys plus `__rollup`. The static file stays in the tree as a fallback no one reads.

---

## 6. Implementation tickets

1. **T1 — Stub godview.json (Pattern C).** Create `site/godview.json` and `_build/build_godview_json.py` per §5 above. Envelope: schema 1.0, project `interpreter`, single-tenant, five metrics each `{value: 0, unit: <count|pct|hours per registry>}`. Sign with `GODVIEW_SHARED_SECRET_INTERPRETER`. Wire registry entry. **20 min** (metrics bus §8 estimate).
2. **T2 — Add `event-capture.js` to marketing pages.** Once `site/index.html` (and any other phase-1 pages) ship, include the shared beacon snippet from `~/Desktop/1891/shared/specs/EVENT_CAPTURE.md`. Configure `project_slug: "interpreter"`. Fire `pageview` and `session_start` on load; fire `outbound_click` on delegated link clicks; fire `error` on `window.onerror` + `unhandledrejection`. **30 min.**
3. **T3 — Wire waitlist + pricing-page events.** Replace the no-op `data-form` submit in `site/assets/js/main.js` with a real POST to the waitlist Worker, then fire `waitlist_signup {role}` to the beacon. Add a `pricing_page_view` beacon fire to `/pricing` (once that page exists). **15 min.**
4. **T4 (deferred to platform launch) — Wire platform events from the reserved list (§4).** When the API Worker is up, emit `interpreter_signup`, `agency_signup`, `job_posted`, `job_filled`, `job_canceled`, `hour_billed`, `availability_updated` server-side from the Worker (not the browser) carrying `agency_id`. Flip the godview registry from Pattern C → Pattern A and add the per-tenant fan-out. Estimate sized then.

T1 is the blocker for the godview dashboard. T2 + T3 unblock the visitor-analytics tile. T4 is post-platform-launch and out of scope for this round.

---

## 7. Risks & open questions

- **Per-agency tenancy in the beacon (carry into T4).** The shared event-capture beacon keys on `project_slug` per `EVENT_CAPTURE.md`. For interpreter that's always `"interpreter"`, but the platform-phase events MUST carry `agency_id` in props and the godview rollup MUST partition by agency. Two implications: (a) the event-capture rollup Worker needs to group on `(project_slug, props.agency_id)` for this project, and (b) godview's per-agency tabs read the partitioned rollup, not the project-level one. Flag for the T4 ticket — confirm `EVENT_CAPTURE.md` accommodates a tenant-prop convention before T4 starts.
- **Apps Script vs. event-capture write-side overlap.** The platform's Apps Script `Audit_Log` is the legal record per PRD A6; the event-capture beacon is product analytics. These are different trust domains and different retention windows (Audit_Log = 7 years, beacon = whatever event-capture sets). The coding agent must not blur them — never mirror an audit row into the beacon, never treat a beacon event as authoritative.
- **`fill_rate_mtd` denominator.** The phase-2 definition above (filled / (filled + canceled + unfilled)) needs a lock-in from Anthony + Fallon during the decisions sweep. PRD section C10 doesn't pin this. Worth a one-line decision in `docs/DECISIONS.md` before T4.
- **`hours_billed_mtd` for free-tier agencies.** Free Deaf-owned agencies still post jobs and bill consumers, so the metric is meaningful for them; we just don't collect a platform fee. Make sure T4 doesn't accidentally filter free-tier hours out of the rollup.
- **Beacon CSP on marketing pages.** Per root CLAUDE.md, CSP on the marketing site needs to allowlist the beacon endpoint (Worker URL). Add the CSP header in `.htaccess` at the same time as T2 so the beacon isn't silently blocked in production.
- **No PHI ever on the beacon.** PRD A6 + project CLAUDE.md are non-negotiable. Pre-merge check for T2 / T3 / T4: `grep -ri 'patient\|diagnos\|consumer_name\|interpreter_name' workers/ site/` — must return zero hits in any code path that talks to the beacon.
