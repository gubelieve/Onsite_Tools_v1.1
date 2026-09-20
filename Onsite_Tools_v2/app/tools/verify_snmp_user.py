"""Verify SNMP User - collect SNMPv2 communities and SNMPv3 users from each device."""
import re

from . import COMMON_DEVICE_FIELDS
from ._ssh_common import error_status, load_devices_or_fail, open_session, save_device_log

TOOL = {
    "id": "verify_snmp_user",
    "name": "Verify SNMP User",
    "category": "Inventory",
    "order": 34,
    "description": "Read 'show run | inc snmp.*community' and 'show snmp user' and summarise SNMPv2/v3 settings per device.",
    "fields": COMMON_DEVICE_FIELDS,
    "columns": ["Hostname", "IP Management", "SNMPv2 Community String", "SNMPv3 User", "SNMPv3 Active Access-List",
                "Authentication Protocol", "Privacy Protocol", "Group-name", "Status", "Output"],
    "runs": [{"id": "run", "label": "Run"}],
}

EXPORT_COLUMNS = ["Hostname", "IP Management", "SNMPv2 Community String", "SNMPv3 User", "SNMPv3 Active Access-List",
                  "Authentication Protocol", "Privacy Protocol", "Group-name", "Site", "Status"]


def parse_snmp_community(output):
    return "; ".join(m.group(1) for m in re.finditer(
        r"snmp-server\s+community\s+(\S+)\s+(?:RO|RW)(?:\s+(\S+))?", output, re.IGNORECASE))


def parse_snmp_user(output, result):
    sections = re.split(r"(?:^|\n)(?:User\s+name|Username):\s*", output, flags=re.MULTILINE | re.IGNORECASE)
    users = []
    for section in sections:
        if not section.strip():
            continue
        first = section.split("\n")[0].strip()
        u = {"user": first.split()[0] if first.split() else "", "access_list": "", "auth_protocol": "",
             "privacy_protocol": "", "group_name": ""}
        for pat in (r"active\s+access-list:\s*(\S+)", r"access-list:\s*(\S+)", r"active\s+access-list\s+(\S+)"):
            m = re.search(pat, section, re.IGNORECASE)
            if m:
                u["access_list"] = m.group(1).strip()
                break
        for pat in (r"Authentication\s+Protocol:\s*(\S+(?:\s+\d+)?)", r"Auth\s+Protocol:\s*(\S+(?:\s+\d+)?)",
                    r"Authentication:\s*(\S+(?:\s+\d+)?)"):
            m = re.search(pat, section, re.IGNORECASE)
            if m:
                u["auth_protocol"] = m.group(1).strip()
                break
        for pat in (r"Privacy\s+Protocol:\s*(\S+(?:\s+\d+)?)", r"Priv\s+Protocol:\s*(\S+(?:\s+\d+)?)",
                    r"Privacy:\s*(\S+(?:\s+\d+)?)"):
            m = re.search(pat, section, re.IGNORECASE)
            if m:
                u["privacy_protocol"] = m.group(1).strip()
                break
        for pat in (r"Group-name:\s*(\S+)", r"Group\s+name:\s*(\S+)", r"Group:\s*(\S+)"):
            m = re.search(pat, section, re.IGNORECASE)
            if m:
                u["group_name"] = m.group(1).strip()
                break
        if u["user"]:
            users.append(u)
    if not users:
        return
    result["SNMPv3 User"] = "; ".join(u["user"] for u in users)

    def combine(k):
        vals = [u[k] for u in users if u[k]]
        if not vals:
            return ""
        uniq = list(dict.fromkeys(vals))
        return "; ".join(uniq) if len(uniq) > 1 else uniq[0]

    result["SNMPv3 Active Access-List"] = combine("access_list")
    result["Authentication Protocol"] = combine("auth_protocol")
    result["Privacy Protocol"] = combine("privacy_protocol")
    result["Group-name"] = combine("group_name")


def run(ctx, params):
    devices = load_devices_or_fail(ctx, params)
    if not devices:
        return
    ctx.set_columns(TOOL["columns"], EXPORT_COLUMNS)
    keys = {}
    for d in devices:
        row = {c: "" for c in TOOL["columns"]}
        row.update({"Hostname": d.get("hostname") or "N/A", "IP Management": d["host"], "Status": "Pending...",
                    "Site": d["site"]})
        keys[d["host"]] = ctx.add_row(row)
    ok = {"n": 0}

    def work(d):
        key = keys[d["host"]]
        try:
            conn, prompt, hostname = open_session(ctx, d, params)
            try:
                ctx.check_stop()
                show_run_snmp = conn.send_command("show run | inc snmp.*community", read_timeout=60)
                ctx.check_stop()
                show_snmp_user = conn.send_command("show snmp user", read_timeout=60)
            finally:
                conn.disconnect()
            raw = f"--- show run | inc snmp.*community ---\n{show_run_snmp}\n\n--- show snmp user ---\n{show_snmp_user}"
            result = {"Hostname": hostname, "SNMPv2 Community String": parse_snmp_community(show_run_snmp)}
            parse_snmp_user(show_snmp_user, result)
            save_device_log(ctx, hostname, d["host"], raw)
            ok["n"] += 1
            ctx.update_row(key, Status="Success", Output=raw, **result)
            ctx.summary(f"Total {ok['n']}/{len(devices)}")
        except Exception as e:
            if ctx.stop_requested:
                ctx.update_row(key, Status="Stopped by user")
                return
            ctx.log(f"Error connecting to {d['host']}: {e}", "ERROR")
            ctx.update_row(key, Status=error_status(e), Output=str(e))

    ctx.map_parallel(devices, work, params.get("threads", 10))
    ctx.info("SNMP user verification finished.")
