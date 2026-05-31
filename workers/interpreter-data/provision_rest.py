#!/usr/bin/env python3
"""
Provision interpreter-data D1 + KV + queue via the Cloudflare REST API.

Why REST and not wrangler: `wrangler` is not on the osascript bridge PATH and its
OAuth account-grant is intermittently broken (reference_cloudflare_account_id).
But the OAuth *bearer* token in ~/Library/Preferences/.wrangler/config/default.toml
authenticates fine against api.cloudflare.com directly (verified 2026-05-31:
/accounts and /d1/database both return success). So we drive the REST API with
that bearer token and bypass the wrangler binary entirely.

Idempotent: if a resource already exists, we reuse it instead of erroring.
Never prints the token. Prints the resulting IDs so they can be pasted into
wrangler.toml.

Usage:
  python3 provision_rest.py create-db          # create/find the D1 database
  python3 provision_rest.py create-kv          # create/find the KV namespace
  python3 provision_rest.py create-queue       # create/find the queue
  python3 provision_rest.py apply-schema <db_id> <path-to-schema.sql>
  python3 provision_rest.py exec <db_id> "<sql>"      # run one statement
  python3 provision_rest.py all                # db + kv + queue + schema, print toml block
"""
import json, os, re, sys, urllib.request, urllib.error

ACCOUNT_ID = "8c3571f09abd644406f30db05056e6d2"
API = "https://api.cloudflare.com/client/v4"
CFG = os.path.expanduser("~/Library/Preferences/.wrangler/config/default.toml")
DB_NAME = "interpreter-data"
KV_TITLE = "interpreter-cache"
QUEUE_NAME = "interpreter-jobs"


def token():
    with open(CFG) as f:
        for line in f:
            m = re.match(r'^\s*oauth_token\s*=\s*"?([^"\n]+)"?', line)
            if m:
                return m.group(1).strip()
    raise SystemExit("no oauth_token in wrangler config")


def call(method, path, body=None):
    url = API + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer " + token())
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode())


def find_db():
    r = call("GET", f"/accounts/{ACCOUNT_ID}/d1/database?per_page=100")
    for d in (r.get("result") or []):
        if d.get("name") == DB_NAME:
            return d.get("uuid")
    return None


def create_db():
    existing = find_db()
    if existing:
        print(f"DB_EXISTS {existing}")
        return existing
    r = call("POST", f"/accounts/{ACCOUNT_ID}/d1/database", {"name": DB_NAME})
    if not r.get("success"):
        raise SystemExit("create-db failed: " + json.dumps(r.get("errors")))
    uuid = r["result"]["uuid"]
    print(f"DB_CREATED {uuid}")
    return uuid


def find_kv():
    r = call("GET", f"/accounts/{ACCOUNT_ID}/storage/kv/namespaces?per_page=100")
    for n in (r.get("result") or []):
        if n.get("title") == KV_TITLE:
            return n.get("id")
    return None


def create_kv():
    existing = find_kv()
    if existing:
        print(f"KV_EXISTS {existing}")
        return existing
    r = call("POST", f"/accounts/{ACCOUNT_ID}/storage/kv/namespaces", {"title": KV_TITLE})
    if not r.get("success"):
        raise SystemExit("create-kv failed: " + json.dumps(r.get("errors")))
    nid = r["result"]["id"]
    print(f"KV_CREATED {nid}")
    return nid


def create_queue():
    # List first (idempotent).
    r = call("GET", f"/accounts/{ACCOUNT_ID}/queues?per_page=100")
    for qd in (r.get("result") or []):
        if qd.get("queue_name") == QUEUE_NAME or qd.get("name") == QUEUE_NAME:
            qid = qd.get("queue_id") or qd.get("id")
            print(f"QUEUE_EXISTS {qid}")
            return qid
    r = call("POST", f"/accounts/{ACCOUNT_ID}/queues", {"queue_name": QUEUE_NAME})
    if not r.get("success"):
        print("QUEUE_SKIP " + json.dumps(r.get("errors")))
        return None
    qid = r["result"].get("queue_id") or r["result"].get("id")
    print(f"QUEUE_CREATED {qid}")
    return qid


def exec_sql(db_id, sql):
    r = call("POST", f"/accounts/{ACCOUNT_ID}/d1/database/{db_id}/query", {"sql": sql})
    return r


def apply_schema(db_id, path):
    with open(path) as f:
        sql = f.read()
    r = exec_sql(db_id, sql)
    if not r.get("success"):
        print("SCHEMA_FAIL " + json.dumps(r.get("errors"))[:600])
        return False
    print("SCHEMA_OK")
    return True


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    cmd = sys.argv[1]
    if cmd == "create-db":
        create_db()
    elif cmd == "create-kv":
        create_kv()
    elif cmd == "create-queue":
        create_queue()
    elif cmd == "apply-schema":
        apply_schema(sys.argv[2], sys.argv[3])
    elif cmd == "exec":
        print(json.dumps(exec_sql(sys.argv[2], sys.argv[3]), indent=2)[:2000])
    elif cmd == "all":
        db = create_db()
        kv = create_kv()
        qid = create_queue()
        here = os.path.dirname(os.path.abspath(__file__))
        apply_schema(db, os.path.join(here, "schema.sql"))
        print("\n--- wrangler.toml ids ---")
        print(f"D1_DATABASE_ID={db}")
        print(f"KV_NAMESPACE_ID={kv}")
        print(f"QUEUE_ID={qid}")
    else:
        print("unknown command: " + cmd)


if __name__ == "__main__":
    main()
