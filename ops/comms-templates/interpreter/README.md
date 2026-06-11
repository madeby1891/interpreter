# Interpreter — comms templates

3-file shape per EMAIL_TEMPLATES.md §1 (html/txt/json), nested-repo placement per §10.
All drip; nothing here sends until the sequence rows flip to `active` AND `COMMS_DRIP=on`
on the shared comms worker — both Anthony-gated, after DMARC hardening.

| id | category | sequence | offset | subject |
|---|---|---|---|---|
| drip-sandbox-01-smartfill | marketing | sandbox-nurture | D+2 | How smart-fill ranks your roster |
| drip-sandbox-02-deaf-owned-free | marketing | sandbox-nurture | D+5 | Free forever, if the agency is Deaf-owned |
| drip-sandbox-03-working-session | marketing | sandbox-nurture | D+9 | Want a human walkthrough? |
| drip-demo-01-nudge | lifecycle | demo-followup | D+1 | Quick nudge — pick your windows |
| drip-demo-02-switching-case | lifecycle | demo-followup | D+4 | What switching actually looks like |
| drip-onboard-01-setup | lifecycle | subscriber-onboarding | D+1 | Day one: get your board breathing |
| drip-onboard-02-checkin | lifecycle | subscriber-onboarding | D+7 | One week in — what is working? |

Variables: `{{unsub_url}}` only (injected by the drip walk). Body URLs are constants on
purpose — a drip send can never refuse on missing vars.

Enrollment: `Code_Funnel.gs` `_commsEnroll_()` → comms worker `POST /v1/enroll`
(X-Comms-Internal HMAC; key in gitignored `apps-script/comms-secret.gs`). Sequences are
seeded in the shared admin D1 as `draft` — flip ritual lives in HANDOFF.
