#!/usr/bin/env python3
"""
build-release-json.py — emit a project's release.json into the web root.

Per shared/specs/CONTINUOUS_LEARNING.md §2.5. The shared event-capture helper
fetches /release.json once on load and stamps every beacon with the release
slug, so we can scope clusters to "errors that started after release X" and
"errors that stopped after release Y."

Shape:
    { "release": "<project>-<yyyy-mm-dd>-<git-sha-short>",
      "built_at": "<iso-8601 utc>" }

Two ways to invoke:

  # 1. From a project's build.py — preferred. Import and call.
  from build_release_json import emit_release_json
  emit_release_json(project_slug="travel", site_dir=SITE_DIR, repo_root=PROJECT_ROOT)

  # 2. From a deploy.sh that wants a "stamp the release only" hook
  python3 _build/build-release-json.py --project=travel --site=site/

The repo_root argument decides which `git rev-parse` is asked for the SHA.
For projects whose `.git` lives at the project root, repo_root == PROJECT_ROOT.
For projects whose `.git` lives in a subdirectory (clerc-classic, fairytale-
dreamers — see INDEX.md), pass the subdir that contains `.git`.

If git is unavailable or the working tree is not a repo, the SHA degrades to
`nogit` and a stderr warning is printed — the build still produces a usable
release.json so the helper does not 404.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import pathlib
import subprocess
import sys


def _git_short_sha(repo_root: pathlib.Path) -> str:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short=7", "HEAD"],
            cwd=str(repo_root),
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
        sha = out.stdout.strip()
        if sha:
            return sha
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired) as e:
        print(f"  release.json: git unavailable ({e}); falling back to 'nogit'", file=sys.stderr)
    return "nogit"


def emit_release_json(
    project_slug: str,
    site_dir: pathlib.Path,
    repo_root: pathlib.Path | None = None,
) -> dict:
    """Write site_dir/release.json. Returns the payload that was written."""
    if repo_root is None:
        repo_root = site_dir.parent

    today = _dt.date.today().isoformat()
    sha = _git_short_sha(repo_root)
    payload = {
        "release": f"{project_slug}-{today}-{sha}",
        "built_at": _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    }

    site_dir.mkdir(parents=True, exist_ok=True)
    out = site_dir / "release.json"
    out.write_text(json.dumps(payload, separators=(",", ":")) + "\n")
    print(f"  release.json: {payload['release']} -> {out}")
    return payload


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Emit release.json into a project's web root.")
    parser.add_argument("--project", required=True, help="project slug (matches event-capture key)")
    parser.add_argument("--site", default="site", help="web-root directory relative to cwd")
    parser.add_argument("--repo", default=None, help="repo root for git rev-parse (default: site's parent)")
    args = parser.parse_args(argv)

    site_dir = pathlib.Path(args.site).resolve()
    repo_root = pathlib.Path(args.repo).resolve() if args.repo else site_dir.parent
    emit_release_json(args.project, site_dir, repo_root)
    return 0


if __name__ == "__main__":
    sys.exit(main())
