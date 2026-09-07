"""SD-WAN API - create vManage site lists from a CSV (grouped by name/description/type/listId)."""
import json
import os
from datetime import datetime

from ..core import csvutil
from ..core.logutil import now_hms, safe_name

TOOL = {
    "id": "sd_wan_api",
    "name": "SD-WAN API (Site List)",
    "category": "Catalyst Center / SD-WAN",
    "order": 62,
    "description": "Login to vManage, POST /template/policy/list/site for every group in the CSV and verify the list "
                   "exists afterwards.",
    "fields": [
        {"name": "base_url", "label": "vManage URL", "type": "text", "required": True,
         "placeholder": "https://vmanage.example.com", "remember": True},
        {"name": "username", "label": "Username", "type": "text", "required": True, "width": "half", "remember": True},
        {"name": "password", "label": "Password", "type": "password", "required": True, "width": "half", "remember": True},
        {"name": "csv_file", "label": "Site list CSV", "type": "file", "accept": ".csv", "required": True,
         "template": "sd_wan_site_list_template.csv", "help": "Columns: name, description, type, listId, siteId"},
        {"name": "verify_ssl", "label": "Verify SSL certificate", "type": "checkbox", "default": False, "width": "half"},
    ],
    "columns": ["Stage", "Hostname", "Status", "Message", "Progress", "Output", "Timestamp"],
    "runs": [{"id": "run", "label": "Run"}],
}


class VManage:
    def __init__(self, ctx, params):
        import requests

        self.ctx = ctx
        self.base = params["base_url"].strip().rstrip("/")
        if not self.base.startswith("http"):
            self.base = "https://" + self.base
        self.s = requests.Session()
        self.s.verify = bool(params.get("verify_ssl"))
        if not self.s.verify:
            try:
                import urllib3

                urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
            except Exception:
                pass
        self.username = params["username"]
        self.password = params["password"]

    def login(self):
        data = {"j_username": self.username, "j_password": self.password}
        last = None
        for url in (f"{self.base}/j_security_check", f"{self.base}/dataservice/j_security_check"):
            try:
                r = self.s.post(url, data=data, timeout=30)
                if r.status_code == 200 and "html" not in r.headers.get("Content-Type", "").lower():
                    break
            except Exception as e:
                last = e
        if last:
            self.ctx.log(f"Login attempts raised exception: {last}", "WARNING")
        for turl in (f"{self.base}/dataservice/client/token", f"{self.base}/client/token"):
            try:
                tr = self.s.get(turl, timeout=20)
                if tr.status_code == 200 and tr.text and "<html" not in tr.text.lower():
                    self.s.headers.update({"X-XSRF-TOKEN": tr.text.strip()})
                    break
            except Exception as e:
                self.ctx.log(f"Token fetch failed (continuing without): {e}")

    def post_site_list(self, payload):
        last = None
        for ep in (f"{self.base}/dataservice/template/policy/list/site", f"{self.base}/template/policy/list/site"):
            try:
                r = self.s.post(ep, json=payload, timeout=60)
                if r.status_code in (200, 201, 202):
                    return True, r.status_code, r.text
                last = f"HTTP {r.status_code}: {r.text[:500]}"
            except Exception as e:
                last = str(e)
        return False, None, last or "Unknown error"

    def fetch_site_lists(self):
        for ep in (f"{self.base}/dataservice/template/policy/list/site", f"{self.base}/template/policy/list/site"):
            try:
                r = self.s.get(ep, timeout=60)
                if r.status_code in (200, 201):
                    try:
                        return True, r.status_code, r.json()
                    except Exception:
                        return True, r.status_code, r.text
            except Exception:
                continue
        return False, None, None


def run(ctx, params):
    ctx.set_columns(TOOL["columns"])

    def emit(stage, host, status, message, progress="", output=""):
        ctx.add_row({"Stage": stage, "Hostname": host, "Status": status, "Message": message, "Progress": str(progress),
                     "Output": output, "Timestamp": now_hms()})

    try:
        emit("Import", "CSV", "Running", f"Loading {os.path.basename(params['csv_file'])}", 5)
        fields, rows = csvutil.read_csv(params["csv_file"])
        required = ["name", "description", "type", "listId", "siteId"]
        cols = {}
        for col in required:
            real = csvutil.find_col(fields, col)
            if not real:
                raise ValueError(f"Missing required column: {col}")
            cols[col] = real
        items = []
        for r in rows:
            item = {k: (r.get(cols[k]) or "").strip() for k in required}
            if item["name"] and item["type"] and item["siteId"]:
                items.append(item)
        if not items:
            raise ValueError("CSV has no valid data rows")
        emit("Auth", "vManage", "Running", "Authenticating to vManage...", 10)
        vm = VManage(ctx, params)
        vm.login()
        emit("Auth", "vManage", "Pass", "Authenticated (or proceeding without token)", 15)
        groups = {}
        for it in items:
            lid = None if it["listId"] == "" or it["listId"].lower() == "null" else it["listId"]
            key = (it["name"], it["description"], it["type"], lid)
            groups.setdefault(key, []).append({"siteId": it["siteId"]})
        total = len(groups)
        ctx.progress(0, total)
        passed = 0
        for idx, ((name, desc, ltype, lid), entries) in enumerate(groups.items(), start=1):
            ctx.check_stop()
            payload = {"name": name, "description": desc, "type": ltype, "listId": lid, "entries": entries}
            pretty = json.dumps(payload, indent=2)
            pct = int(15 + (idx / total) * 80)
            emit("POST", name, "Running", f"Posting site list with {len(entries)} entries", pct, pretty)
            ok, code, text = vm.post_site_list(payload)
            try:
                with open(os.path.join(ctx.run_dir, f"group_{idx:03d}_{safe_name(name)}_{datetime.now().strftime('%y%m%d_%H%M%S')}.log"),
                          "w", encoding="utf-8") as lf:
                    lf.write("REQUEST:\n" + pretty + "\n\nRESPONSE:\n" + f"HTTP {code if code is not None else 'NA'}\n" + str(text))
            except Exception as e:
                ctx.log(f"Failed to write group log: {e}", "WARNING")
            if ok:
                emit("POST", name, "Completed", f"HTTP {code}: vManage accepted request", pct, str(text))
            else:
                emit("POST", name, "Failed", f"HTTP {code if code is not None else 'NA'}: {text}", pct, str(text))
            v_ok, v_code, v_data = vm.fetch_site_lists()
            found = False
            if v_ok and v_data is not None:
                arr = v_data.get("data") if isinstance(v_data, dict) else None
                if isinstance(arr, list):
                    found = any(str(i.get("name", "")) == name and str(i.get("type", "")) == ltype for i in arr)
                elif isinstance(v_data, str) and name in v_data:
                    found = True
            status = "Pass" if (ok and found) else ("Warning" if ok else "Failed")
            if status == "Pass":
                passed += 1
            emit("Verify", name, status, f"Verify GET HTTP {v_code if v_code is not None else 'NA'}: "
                                         f"{'Found' if found else 'Not found'}", pct,
                 json.dumps(v_data) if isinstance(v_data, (dict, list)) else str(v_data))
            ctx.step()
        emit("Done", "All", "Completed", f"Processed {total} group(s)", 100)
        ctx.summary(f"{passed}/{total} site list(s) verified")
    except Exception as e:
        ctx.log(f"sd_wan_api failed: {e}", "ERROR")
        emit("Error", "sd-wan", "Failed", str(e), 0, str(e))
    ctx.info("SD-WAN API processing finished.")
