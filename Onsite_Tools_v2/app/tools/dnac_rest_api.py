"""DNAC REST API - call a list of Catalyst Center (DNAC) GET endpoints and save the JSON."""
import json
import os
from datetime import datetime

from ..core import csvutil
from ..core.paths import EXPORTS_DIR

TOOL = {
    "id": "dnac_rest_api",
    "name": "DNAC REST API",
    "category": "Catalyst Center / SD-WAN",
    "order": 60,
    "description": "Call each endpoint from the URL list (GET) against a Catalyst Center and save the JSON reply to "
                   "exports/dnac_output/.",
    "fields": [
        {"name": "url_file", "label": "URL list (CSV)", "type": "file", "accept": ".csv", "required": True,
         "template": "dnac_urls_template.csv", "help": "Columns: URL_Name, Endpoint"},
        {"name": "server_ip", "label": "Server IP / host", "type": "text", "required": True, "placeholder": "10.0.0.1",
         "width": "half", "remember": True},
        {"name": "auth_mode", "label": "Authentication", "type": "select", "width": "half", "default": "token",
         "options": [{"value": "token", "label": "X-Auth-Token (recommended)"}, {"value": "basic", "label": "Basic auth"}]},
        {"name": "username", "label": "Username", "type": "text", "required": True, "width": "half", "remember": True},
        {"name": "password", "label": "Password", "type": "password", "required": True, "width": "half", "remember": True},
        {"name": "verify_ssl", "label": "Verify SSL certificate", "type": "checkbox", "default": False, "width": "half",
         "help": "Untick for self-signed certificates."},
        {"name": "threads", "label": "Max threads", "type": "number", "default": 5, "min": 1, "max": 50, "width": "half"},
    ],
    "columns": ["URL Name", "Endpoint", "Status", "Output File", "Response"],
    "runs": [{"id": "run", "label": "Submit REST API Calls"}],
}


def _session(params):
    import requests

    s = requests.Session()
    s.verify = bool(params.get("verify_ssl"))
    if not s.verify:
        try:
            import urllib3

            urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
        except Exception:
            pass
    s.headers.update({"Content-Type": "application/json", "Accept": "application/json"})
    base = f"https://{params['server_ip'].strip().rstrip('/')}"
    if params.get("auth_mode", "token") == "token":
        r = s.post(f"{base}/dna/system/api/v1/auth/token", auth=(params["username"], params["password"]), timeout=30)
        if r.status_code not in (200, 201) or not r.json().get("Token"):
            raise RuntimeError(f"Token request failed: HTTP {r.status_code} {r.text[:200]}")
        s.headers["X-Auth-Token"] = r.json()["Token"]
    else:
        s.auth = (params["username"], params["password"])
    return s, base


def run(ctx, params):
    fields, rows = csvutil.read_csv(params.get("url_file"))
    name_col = csvutil.find_col(fields, "URL_Name", "name")
    ep_col = csvutil.find_col(fields, "Endpoint", "url", "path")
    if not name_col or not ep_col:
        ctx.error("CSV must contain 'URL_Name' and 'Endpoint' columns.")
        return
    urls = [r for r in rows if r.get(name_col) and r.get(ep_col)][:500]
    if not urls:
        ctx.error("No valid URLs found in the file.")
        return
    ctx.set_columns(TOOL["columns"])
    keys = {}
    for r in urls:
        keys[r[ep_col]] = ctx.add_row({"URL Name": r[name_col], "Endpoint": r[ep_col], "Status": "Pending...",
                                       "Output File": "", "Response": ""})
    try:
        session, base = _session(params)
    except Exception as e:
        ctx.error(f"Authentication failed: {e}")
        for k in keys.values():
            ctx.update_row(k, Status="Auth failed", Response=str(e))
        return
    out_dir = os.path.join(EXPORTS_DIR, "dnac_output")
    os.makedirs(out_dir, exist_ok=True)
    ok = {"n": 0}

    def work(r):
        key = keys[r[ep_col]]
        url = base + (r[ep_col] if r[ep_col].startswith("/") else "/" + r[ep_col])
        try:
            resp = session.get(url, timeout=60)
            if resp.status_code == 200:
                safe = "".join(c for c in r[name_col] if c.isalnum() or c in " -_").rstrip() or "response"
                fname = f"{safe}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
                path = os.path.join(out_dir, fname)
                try:
                    data = resp.json()
                    text = json.dumps(data, indent=2, ensure_ascii=False)
                except ValueError:
                    text = resp.text
                with open(path, "w", encoding="utf-8") as f:
                    f.write(text)
                ok["n"] += 1
                ctx.artifact(fname, path)
                ctx.update_row(key, Status="Success", Response=text[:20000], **{"Output File": path})
            else:
                ctx.update_row(key, Status=f"HTTP {resp.status_code}", Response=resp.text[:20000], **{"Output File": "N/A"})
        except Exception as e:
            ctx.log(f"REST API error for {url}: {e}", "ERROR")
            ctx.update_row(key, Status="Request Error", Response=str(e), **{"Output File": "N/A"})

    ctx.map_parallel(urls, work, params.get("threads", 5))
    ctx.summary(f"Total {ok['n']}/{len(urls)}")
    ctx.info("REST API calls have completed.")
