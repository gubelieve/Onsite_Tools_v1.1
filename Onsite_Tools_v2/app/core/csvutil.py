"""CSV helpers shared by all tools.

Device list CSVs from v1.1 use ``Site,IP_Address[,Device_Type,Description,...]``.
The IOS-upgrade list uses ``ip_mgmt,hostname,zone,model,brand,device_type``.
Both are accepted here through case-insensitive column aliases.
"""
import csv
import os

MAX_CSV_BYTES = 10 * 1024 * 1024

IP_ALIASES = ("ip_address", "ip", "ip_mgmt", "host", "management_ip", "managementipaddress", "ipaddress")
SITE_ALIASES = ("site", "zone", "location")
TYPE_ALIASES = ("device_type", "devicetype", "type", "platform")
HOSTNAME_ALIASES = ("hostname", "name", "device_name")


def _clean(name):
    return (name or "").strip().lstrip("﻿")


def read_csv(path):
    """Return (fieldnames, rows) with BOM-safe headers. Rows are dicts of stripped strings."""
    if not path or not os.path.exists(path):
        raise FileNotFoundError(f"CSV file not found: {path}")
    if os.path.getsize(path) > MAX_CSV_BYTES:
        raise ValueError("CSV file exceeds the 10 MB limit")
    ext = os.path.splitext(path)[1].lower()
    if ext in (".xlsx", ".xls"):
        return _read_excel(path)
    with open(path, "r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        fields = [_clean(c) for c in (reader.fieldnames or [])]
        rows = []
        for raw in reader:
            row = {}
            for k, v in raw.items():
                if k is None:
                    continue
                if isinstance(v, list):
                    v = ",".join(str(x) for x in v)
                row[_clean(k)] = (v or "").strip() if isinstance(v, str) else ("" if v is None else str(v))
            if any(val for val in row.values()):
                rows.append(row)
    return fields, rows


def _read_excel(path):
    import pandas as pd

    df = pd.read_excel(path)
    df = df.fillna("")
    fields = [_clean(str(c)) for c in df.columns]
    rows = []
    for _, r in df.iterrows():
        row = {_clean(str(k)): str(v).strip() for k, v in r.items()}
        if any(row.values()):
            rows.append(row)
    return fields, rows


def find_col(fields, *aliases):
    """Return the real column name matching one of the aliases (case-insensitive)."""
    lower = {f.lower().replace(" ", "_"): f for f in fields}
    for a in aliases:
        if a.lower() in lower:
            return lower[a.lower()]
    return None


def unique_values(path, column):
    fields, rows = read_csv(path)
    col = find_col(fields, column) or (find_col(fields, *SITE_ALIASES) if column.lower() in SITE_ALIASES else None)
    if not col:
        return []
    seen = []
    for r in rows:
        v = r.get(col, "")
        if v and v not in seen:
            seen.append(v)
    return sorted(seen)


def load_devices(path, site_filter="All", max_devices=1000):
    """Return a list of normalised device dicts:
    {host, site, device_type, hostname, raw:<original row>}.
    """
    fields, rows = read_csv(path)
    ip_col = find_col(fields, *IP_ALIASES)
    if not ip_col:
        raise ValueError("CSV must contain an IP column (IP_Address / ip_mgmt / ip)")
    site_col = find_col(fields, *SITE_ALIASES)
    type_col = find_col(fields, *TYPE_ALIASES)
    host_col = find_col(fields, *HOSTNAME_ALIASES)
    devices = []
    for r in rows:
        host = (r.get(ip_col) or "").strip()
        if not host:
            continue
        site = (r.get(site_col) or "").strip() if site_col else ""
        if site_filter and site_filter not in ("All", "All Sites", "") and site != site_filter:
            continue
        devices.append({
            "host": host,
            "site": site,
            "device_type": ((r.get(type_col) or "").strip() if type_col else "") or "",
            "hostname": (r.get(host_col) or "").strip() if host_col else "",
            "raw": r,
        })
    if len(devices) > max_devices:
        devices = devices[:max_devices]
    return devices


def write_csv(path, columns, rows):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(columns), extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow({c: _cell(r.get(c, "")) for c in columns})


def _cell(v):
    if v is None:
        return ""
    if isinstance(v, (list, tuple)):
        return "; ".join(str(x) for x in v)
    return str(v)
