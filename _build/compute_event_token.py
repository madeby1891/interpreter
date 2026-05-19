#!/usr/bin/env python3
"""
compute_event_token.py — emit today's per-day HMAC token for event-capture.

Per shared/specs/EVENT_CAPTURE.md §3 + CONTINUOUS_LEARNING.md §3.1. The
event-capture Worker accepts a token of the form:

    HMAC_SHA256(secret, f"{project}|{YYYYMMDD}").hex()

where `secret` is the value of the Wrangler secret
EVENT_INGEST_SECRET_<PROJECT_UPPER>, also exported into the build env so the
build can embed today's token into static HTML.

The Worker keeps a 24h grace window — yesterday's token is also accepted —
so daily rebuilds are sufficient. Projects with weekly rebuild cadence
should add a per-project --grace-days arg here AND extend the Worker.

Usage from a project's build.py:

    from compute_event_token import event_token
    token = event_token("travel")   # reads EVENT_INGEST_SECRET_TRAVEL
    head = HEAD_TPL.format(event_token=token, …)

Returns an empty string if the secret env var is unset, so the build keeps
working in environments that don't have the secret (the Worker will simply
reject the resulting token).
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import hmac
import os
import sys


def event_token(project: str, day: str | None = None) -> str:
    env_key = "EVENT_INGEST_SECRET_" + project.upper().replace("-", "_")
    secret = os.environ.get(env_key, "")
    if not secret:
        print(f"  [warn] {env_key} not set in env — event-capture token will be empty",
              file=sys.stderr)
        return ""
    if day is None:
        day = _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%d")
    msg = f"{project}|{day}".encode("utf-8")
    return hmac.new(secret.encode("utf-8"), msg, hashlib.sha256).hexdigest()


if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--project", required=True)
    p.add_argument("--day", default=None, help="YYYYMMDD, default today UTC")
    args = p.parse_args()
    sys.stdout.write(event_token(args.project, args.day))
    sys.stdout.write("\n")
