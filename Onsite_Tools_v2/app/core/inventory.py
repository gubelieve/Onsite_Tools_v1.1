"""Site Inventory - persistent device store shared by every device tool.

Device lists are imported once (CSV / XLSX) from the *Site Inventory* menu and kept in
``data/site_inventory.json``. Tools no longer upload a CSV; they pick a *device list*
(the name given at import time, by default the file name) and a *site*.

Record layout::

    device = {id, list, site, ip, hostname, device_type, model, brand, description,
              extra: {<any other CSV column>: value}, source, updated}
    import = {id, list, filename, mode, imported_at, rows, added, updated, skipped, removed}
"""
import json
import os
import threading
import uuid
from datetime import datetime

from . import csvutil
from .paths import DATA_DIR

ALL = ("", "All", "All Sites", "All Lists", None)
STANDARD_COLUMNS = ["List", "Site", "IP_Address", "Hostname", "Device_Type", "Model", "Brand", "Description"]
MODEL_ALIASES = ("model", "pid", "platform_id")
BRAND_ALIASES = ("brand", "vendor", "os")
DESC_ALIASES = ("description", "desc", "remark", "note")
MAX_IMPORT_HISTORY = 200


def _now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _is_all(value):
    return value in ALL


class Inventory:
    def __init__(self, path):
        self.path = path
        self.lock = threading.RLock()

    # ------------------------------------------------------------ storage
    def _load(self):
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            data = {}
        data.setdefault("devices", [])
        data.setdefault("imports", [])
        return data

    def _save(self, data):
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        os.replace(tmp, self.path)

    # ------------------------------------------------------------ queries
    def devices(self, list_name=None, site=None, q=None):
        with self.lock:
            devs = self._load()["devices"]
        if not _is_all(list_name):
            devs = [d for d in devs if d["list"] == list_name]
        if not _is_all(site):
            devs = [d for d in devs if d["site"] == site]
        if q:
            ql = q.lower()
            devs = [d for d in devs if ql in " ".join(
                [d["list"], d["site"], d["ip"], d["hostname"], d["device_type"], d["model"], d["brand"],
                 d["description"]] + [str(v) for v in d.get("extra", {}).values()]).lower()]
        return devs

    def lists(self):
        with self.lock:
            data = self._load()
        out = {}
        for d in data["devices"]:
            item = out.setdefault(d["list"], {"name": d["list"], "count": 0, "sites": set(), "updated": ""})
            item["count"] += 1
            if d["site"]:
                item["sites"].add(d["site"])
            item["updated"] = max(item["updated"], d.get("updated", ""))
        last_file = {}
        for imp in data["imports"]:
            last_file[imp["list"]] = imp["filename"]
        return [dict(v, sites=sorted(v["sites"]), filename=last_file.get(k, "")) for k, v in sorted(out.items())]

    def sites(self, list_name=None):
        return sorted({d["site"] for d in self.devices(list_name) if d["site"]})

    def imports(self):
        with self.lock:
            return list(reversed(self._load()["imports"]))

    def summary(self):
        lists = self.lists()
        return {"lists": lists, "sites": self.sites(), "total": sum(x["count"] for x in lists)}

    def get_devices(self, list_name=None, site=None, max_devices=5000):
        """Normalised devices for tools: {host, site, device_type, hostname, raw}. De-duplicated by IP."""
        seen, out = set(), []
        for d in self.devices(list_name, site):
            if d["ip"] in seen:
                continue
            seen.add(d["ip"])
            raw = dict(d.get("extra", {}))
            raw.update({"List": d["list"], "Site": d["site"], "IP_Address": d["ip"], "Hostname": d["hostname"],
                        "Device_Type": d["device_type"], "Model": d["model"], "Brand": d["brand"],
                        "Description": d["description"]})
            out.append({"host": d["ip"], "site": d["site"], "device_type": d["device_type"],
                        "hostname": d["hostname"], "description": d["description"], "raw": raw})
        return out[:max_devices]

    # ------------------------------------------------------------ changes
    @staticmethod
    def _record(list_name, site, ip, hostname="", device_type="", model="", brand="", description="", extra=None,
                source=""):
        return {"id": uuid.uuid4().hex[:12], "list": list_name, "site": site, "ip": ip, "hostname": hostname,
                "device_type": device_type, "model": model, "brand": brand, "description": description,
                "extra": extra or {}, "source": source, "updated": _now()}

    def import_rows(self, fields, rows, list_name, filename="", mode="merge", default_site=""):
        """Import parsed CSV rows into ``list_name``.

        mode ``merge``   - add new devices, update devices whose IP already exists in the list
        mode ``replace`` - the list ends up containing exactly the rows of this file
        """
        list_name = (list_name or "").strip() or os.path.splitext(os.path.basename(filename))[0] or "default"
        ip_col = csvutil.find_col(fields, *csvutil.IP_ALIASES)
        if not ip_col:
            raise ValueError("File must contain an IP column (IP_Address / ip_mgmt / ip / managementIpAddress)")
        cols = {
            "site": csvutil.find_col(fields, *csvutil.SITE_ALIASES),
            "hostname": csvutil.find_col(fields, *csvutil.HOSTNAME_ALIASES),
            "device_type": csvutil.find_col(fields, "device_type", "devicetype"),
            "model": csvutil.find_col(fields, *MODEL_ALIASES),
            "brand": csvutil.find_col(fields, *BRAND_ALIASES),
            "description": csvutil.find_col(fields, *DESC_ALIASES),
        }
        used = {ip_col} | {c for c in cols.values() if c}
        added = updated = skipped = removed = 0
        with self.lock:
            data = self._load()
            if mode == "replace":
                before = len(data["devices"])
                data["devices"] = [d for d in data["devices"] if d["list"] != list_name]
                removed = before - len(data["devices"])
            index = {d["ip"]: d for d in data["devices"] if d["list"] == list_name}
            for r in rows:
                ip = (r.get(ip_col) or "").strip()
                if not ip:
                    skipped += 1
                    continue
                values = {k: (r.get(c) or "").strip() if c else "" for k, c in cols.items()}
                values["site"] = values["site"] or (default_site or "").strip()
                extra = {k: v for k, v in r.items() if k and k not in used and v != ""}
                if ip in index:
                    index[ip].update(values, extra=extra, source=filename, updated=_now())
                    updated += 1
                else:
                    rec = self._record(list_name, ip=ip, extra=extra, source=filename, **values)
                    data["devices"].append(rec)
                    index[ip] = rec
                    added += 1
            result = {"id": uuid.uuid4().hex[:12], "list": list_name, "filename": filename, "mode": mode,
                      "imported_at": _now(), "rows": len(rows), "added": added, "updated": updated,
                      "skipped": skipped, "removed": removed}
            data["imports"] = (data["imports"] + [result])[-MAX_IMPORT_HISTORY:]
            self._save(data)
        return result

    def upsert_device(self, payload):
        ip = (payload.get("ip") or "").strip()
        list_name = (payload.get("list") or "").strip() or "manual"
        if not ip:
            raise ValueError("IP address is required")
        clean = {k: (payload.get(k) or "").strip() for k in
                 ("site", "hostname", "device_type", "model", "brand", "description")}
        with self.lock:
            data = self._load()
            target = None
            if payload.get("id"):
                target = next((d for d in data["devices"] if d["id"] == payload["id"]), None)
                if target is None:
                    raise KeyError("device not found")
            clash = next((d for d in data["devices"] if d["list"] == list_name and d["ip"] == ip and d is not target),
                         None)
            if clash:
                raise ValueError(f"{ip} already exists in list '{list_name}'")
            if target is None:
                target = self._record(list_name, ip=ip, source="manual", **clean)
                data["devices"].append(target)
            else:
                target.update(clean, list=list_name, ip=ip, updated=_now())
            self._save(data)
            return target

    def delete_device(self, device_id):
        with self.lock:
            data = self._load()
            before = len(data["devices"])
            data["devices"] = [d for d in data["devices"] if d["id"] != device_id]
            self._save(data)
            return before - len(data["devices"])

    def delete_list(self, list_name):
        with self.lock:
            data = self._load()
            before = len(data["devices"])
            data["devices"] = [d for d in data["devices"] if d["list"] != list_name]
            self._save(data)
            return before - len(data["devices"])

    def export_rows(self, list_name=None, site=None):
        devs = self.devices(list_name, site)
        extra_cols = []
        for d in devs:
            for k in d.get("extra", {}):
                if k not in extra_cols:
                    extra_cols.append(k)
        rows = []
        for d in devs:
            row = {"List": d["list"], "Site": d["site"], "IP_Address": d["ip"], "Hostname": d["hostname"],
                   "Device_Type": d["device_type"], "Model": d["model"], "Brand": d["brand"],
                   "Description": d["description"]}
            row.update(d.get("extra", {}))
            rows.append(row)
        return STANDARD_COLUMNS + extra_cols, rows


store = Inventory(os.path.join(DATA_DIR, "site_inventory.json"))


def devices_for(ctx, params):
    """Used by tools: resolve the inventory selection in ``params`` or explain what is missing."""
    devices = store.get_devices(params.get("inventory_list"), params.get("site"))
    if not devices:
        if store.summary()["total"] == 0:
            ctx.error("Site Inventory is empty. Open the 'Site Inventory' menu and import a device list first.")
        else:
            ctx.warn("No devices in Site Inventory match the selected device list / site.")
    return devices
