"""DNAC Port Assignment - device details + SDA port assignments from Catalyst Center."""
import csv
import json
import os
from datetime import datetime

from ..core import csvutil
from ..core.logutil import now_hms

TOOL = {
    "id": "dnac_port_assignment",
    "name": "DNAC Port Assignment",
    "category": "Catalyst Center / SD-WAN",
    "order": 61,
    "description": "For each device in the CSV (hostname, managementIpAddress) fetch the network-device record and its "
                   "SDA port assignments, then save a combined result CSV.",
    "fields": [
        {"name": "base_url", "label": "Catalyst Center URL", "type": "text", "required": True,
         "placeholder": "https://10.0.0.1", "remember": True},
        {"name": "username", "label": "Username", "type": "text", "required": True, "width": "half", "remember": True},
        {"name": "password", "label": "Password", "type": "password", "required": True, "width": "half", "remember": True},
        {"name": "csv_file", "label": "Device CSV", "type": "file", "accept": ".csv",
         "template": "dnac_port_assignment_template.csv",
         "help": "Columns: hostname, managementIpAddress. Leave empty to just dump all port assignments."},
        {"name": "verify_ssl", "label": "Verify SSL certificate", "type": "checkbox", "default": False, "width": "half"},
    ],
    "columns": ["Stage", "Hostname", "Status", "Message", "Progress", "Output", "Timestamp"],
    "runs": [{"id": "run", "label": "Run (GET)"}],
}

RESULT_FIELDS = ["hostname", "managementIpAddress", "platformId", "softwareVersion", "serialNumber", "instanceUuid",
                 "instanceTenantId", "id", "fabricId", "networkDeviceId", "interfaceName", "connectedDeviceType",
                 "dataVlanName", "voiceVlanName", "authenticateTemplateName", "interfaceDescription"]


class Client:
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

    def log_api(self, label, req, resp):
        try:
            safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in label)[:60]
            path = os.path.join(self.ctx.run_dir, f"api_{safe}_{datetime.now().strftime('%y%m%d_%H%M%S')}.log")
            with open(path, "w", encoding="utf-8") as f:
                f.write("REQUEST\n" + json.dumps(req, indent=2, ensure_ascii=False) + "\n\nRESPONSE\n")
                f.write(json.dumps(resp, indent=2, ensure_ascii=False) if isinstance(resp, (dict, list)) else str(resp))
        except Exception as e:
            self.ctx.log(f"Failed to write API log for {label}: {e}", "WARNING")

    def login(self):
        url = f"{self.base}/dna/system/api/v1/auth/token"
        r = self.s.post(url, auth=(self.username, self.password), timeout=30)
        body = r.text
        self.log_api("auth_token", {"method": "POST", "url": url, "user": self.username}, {"status": r.status_code,
                                                                                            "body": body[:2000]})
        if r.status_code in (200, 201) and r.json().get("Token"):
            self.s.headers.update({"X-Auth-Token": r.json()["Token"]})
            return True
        return False

    def get(self, label, path, params=None, timeout=60):
        url = f"{self.base}{path}"
        try:
            r = self.s.get(url, params=params, timeout=timeout)
            if r.status_code == 200:
                data = r.json()
                self.log_api(label, {"method": "GET", "url": url, "params": params}, {"status": 200, "body": data})
                return True, data
            self.log_api(label + "_error", {"method": "GET", "url": url, "params": params},
                         {"status": r.status_code, "body": r.text})
            return False, f"HTTP {r.status_code}: {r.text[:500]}"
        except Exception as e:
            self.log_api(label + "_exception", {"method": "GET", "url": url, "params": params}, str(e))
            return False, str(e)


def run(ctx, params):
    ctx.set_columns(TOOL["columns"])

    def emit(stage, host, status, message, progress="", output=""):
        ctx.add_row({"Stage": stage, "Hostname": host, "Status": status, "Message": message, "Progress": str(progress),
                     "Output": output, "Timestamp": now_hms()})

    try:
        client = Client(ctx, params)
        if not client.login():
            emit("Auth", "DNAC", "Failed", "Authentication failed", 0)
            return
        emit("Auth", "DNAC", "Pass", "Authenticated", 5)
        csv_path = params.get("csv_file")
        if not csv_path:
            ok, data = client.get("port_assignments_global", "/dna/intent/api/v1/sda/portAssignments")
            out = json.dumps(data, indent=2) if ok else str(data)
            emit("GET", "portAssignments", "Completed" if ok else "Failed", "Fetched assignments", 100, out)
            if ok:
                path = os.path.join(ctx.run_dir, "portAssignments.json")
                with open(path, "w", encoding="utf-8") as f:
                    f.write(out)
                ctx.artifact("portAssignments.json", path)
            return
        emit("Import", "CSV", "Running", "Loading CSV...", 10)
        fields, rows = csvutil.read_csv(csv_path)
        hcol = csvutil.find_col(fields, "hostname")
        icol = csvutil.find_col(fields, "managementIpAddress", "ip_address", "ip")
        if not hcol or not icol:
            raise ValueError("Missing required column: hostname / managementIpAddress")
        devices = [{"hostname": r.get(hcol, ""), "ip": r.get(icol, "")} for r in rows if r.get(icol)]
        if not devices:
            raise ValueError("CSV has no valid data rows")
        ctx.progress(0, len(devices))
        results = []
        for idx, d in enumerate(devices, start=1):
            ctx.check_stop()
            pct = int(20 + (idx / len(devices)) * 70)
            emit("Device", d["hostname"], "Running", f"Fetching device by IP {d['ip']}", pct)
            ok, data = client.get(f"network_device_{d['ip']}", "/dna/intent/api/v1/network-device",
                                  {"managementIpAddress": d["ip"]}, 30)
            item = None
            if ok and isinstance(data, dict):
                devs = data.get("response") or data.get("devices") or []
                if isinstance(devs, list) and devs:
                    item = devs[0]
            if not item:
                emit("Device", d["hostname"], "Failed", f"Device not found for IP {d['ip']}", pct, str(data))
                ctx.step()
                continue
            base = {"hostname": d["hostname"], "managementIpAddress": d["ip"],
                    "platformId": item.get("platformId", ""), "softwareVersion": item.get("softwareVersion", ""),
                    "serialNumber": item.get("serialNumber", ""), "instanceUuid": item.get("instanceUuid", ""),
                    "instanceTenantId": item.get("instanceTenantId", ""), "id": item.get("id", "")}
            pa_ok, pa = client.get(f"port_assignments_{base['id']}", "/dna/intent/api/v1/sda/portAssignments",
                                   {"networkDeviceId": base["id"]})
            expanded = False
            if pa_ok and isinstance(pa, dict):
                for a in (pa.get("response") or pa.get("data") or []):
                    out = dict(base)
                    out.update({k: a.get(k, "") for k in ("fabricId", "networkDeviceId", "interfaceName",
                                                          "connectedDeviceType", "dataVlanName", "voiceVlanName",
                                                          "authenticateTemplateName", "interfaceDescription")})
                    results.append(out)
                    expanded = True
            if not expanded:
                out = dict(base)
                out.update({k: "" for k in RESULT_FIELDS if k not in out})
                results.append(out)
            emit("Device", d["hostname"], "Completed", "Collected device and port assignments", pct,
                 json.dumps(results[-1], indent=2))
            ctx.step()
        out_csv = os.path.join(ctx.run_dir, f"result_{datetime.now().strftime('%y%m%d_%H%M%S')}.csv")
        with open(out_csv, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.DictWriter(f, fieldnames=RESULT_FIELDS, extrasaction="ignore")
            w.writeheader()
            w.writerows(results)
        ctx.artifact(os.path.basename(out_csv), out_csv)
        emit("Export", "CSV", "Completed", f"Saved result CSV: {out_csv}", 100, out_csv)
        ctx.summary(f"{len(results)} port-assignment rows from {len(devices)} device(s)")
    except Exception as e:
        ctx.log(f"dnac_port_assignment failed: {e}", "ERROR")
        emit("Error", "dnac", "Failed", str(e), 0, str(e))
    ctx.info("DNAC processing finished.")
