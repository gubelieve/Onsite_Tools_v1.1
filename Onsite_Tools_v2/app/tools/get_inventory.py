"""Get Inventory - show version + show inventory, parse PID / serial / version."""
import re

from . import COMMON_DEVICE_FIELDS
from ._ssh_common import error_status, load_devices_or_fail, open_session, save_device_log

TOOL = {
    "id": "get_inventory",
    "name": "Get Inventory",
    "category": "Inventory",
    "order": 30,
    "description": "Collect hostname, PID, serial number and software version from each device via SSH.",
    "fields": COMMON_DEVICE_FIELDS,
    "columns": ["Hostname", "IP Address", "PID", "Serial Number", "Version", "SW Type", "Status", "Output"],
    "runs": [{"id": "run", "label": "Run"}],
}

EXPORT_COLUMNS = ["Hostname", "IP Address", "PID", "Serial Number", "Version", "SW Type", "Status", "Site", "Output"]


def parse_output(show_ver, show_inv, result):
    m = re.search(r"Cisco IOS XE Software, Version (\S+)", show_ver)
    if m:
        result["Version"] = m.group(1)
        result["SW Type"] = "IOS XE"
    else:
        m = re.search(r"Cisco IOS Software, .* Version (\S+),", show_ver)
        if m:
            result["Version"] = m.group(1)
            result["SW Type"] = "IOS"
        else:
            m = re.search(r"NXOS: version (\S+)", show_ver)
            if m:
                result["Version"] = m.group(1)
                result["SW Type"] = "NX-OS"
            else:
                m = re.search(r"[Vv]ersion\s+([\w.()]+)", show_ver)
                if m:
                    result["Version"] = m.group(1)
    pid = re.search(r"PID:\s*(\S+)\s*,", show_inv, re.IGNORECASE)
    sn = re.search(r"SN:\s*(\S+)\s*", show_inv, re.IGNORECASE)
    if pid:
        result["PID"] = pid.group(1)
    if sn:
        result["Serial Number"] = sn.group(1)


def run(ctx, params):
    devices = load_devices_or_fail(ctx, params)
    if not devices:
        return
    ctx.set_columns(TOOL["columns"], EXPORT_COLUMNS)
    keys = {d["host"]: ctx.add_row({"Hostname": d.get("hostname") or "N/A", "IP Address": d["host"], "PID": "N/A",
                                    "Serial Number": "N/A", "Version": "N/A", "SW Type": "N/A",
                                    "Status": "Pending...", "Site": d["site"], "Output": ""}) for d in devices}
    ok = {"n": 0}

    def work(d):
        key = keys[d["host"]]
        result = {}
        try:
            conn, prompt, hostname = open_session(ctx, d, params)
            try:
                ctx.update_row(key, Hostname=hostname, Status="Collecting...")
                ctx.check_stop()
                show_ver = conn.send_command("show version", read_timeout=90)
                ctx.check_stop()
                show_inv = conn.send_command("show inventory", read_timeout=90)
            finally:
                conn.disconnect()
            raw = f"--- show version ---\n{show_ver}\n\n--- show inventory ---\n{show_inv}"
            parse_output(show_ver, show_inv, result)
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
    ctx.info("Inventory collection finished.")
