"""CDP Inventory - parse 'show cdp neighbor detail' from every device."""
import re

from . import COMMON_DEVICE_FIELDS
from ._ssh_common import load_devices_or_fail, open_session, save_device_log

TOOL = {
    "id": "cdp_inventory",
    "name": "CDP Inventory",
    "category": "Inventory",
    "order": 31,
    "description": "Collect CDP neighbours (Device ID, IP, platform, local interface, port ID, version) from each device.",
    "fields": COMMON_DEVICE_FIELDS,
    "columns": ["Device Switch", "Device ID", "IP address", "Platform", "Interface", "Port ID", "Version", "Site", "raw_output"],
    "runs": [{"id": "run", "label": "Run"}],
}


def parse_blocks(output, hostname, site):
    rows = []
    for block in re.split(r"-{3,}\n", output):
        if not block.strip() or "Device ID" not in block:
            continue
        r = {"Device Switch": hostname, "Device ID": "", "IP address": "", "Platform": "", "Interface": "",
             "Port ID": "", "Version": "", "Site": site, "raw_output": block.strip()}
        m = re.search(r"Device ID: ([^\n]+)", block)
        if m:
            r["Device ID"] = m.group(1).strip()
        m = re.search(r"Management address\(es\):\s*\n\s*IP address: ([0-9.]+)", block) or \
            re.search(r"Entry address\(es\):\s*\n\s*IP address: ([0-9.]+)", block)
        if m:
            r["IP address"] = m.group(1).strip()
        m = re.search(r"Platform: ([^,\n]+)", block)
        if m:
            r["Platform"] = m.group(1).strip()
        m = re.search(r"Interface: ([^,\n]+)", block)
        if m:
            r["Interface"] = m.group(1).strip()
        m = re.search(r"Port ID \(outgoing port\): ([^\n]+)", block)
        if m:
            r["Port ID"] = m.group(1).strip()
        m = re.search(r"Product Version: ([^\s]+)", block) or re.search(r"Version[ :]+([^,\n]+)", block)
        if m:
            r["Version"] = m.group(1).strip()
        rows.append(r)
    return rows


def run(ctx, params):
    devices = load_devices_or_fail(ctx, params)
    if not devices:
        return
    ctx.set_columns(TOOL["columns"])
    ok = {"n": 0}

    def work(d):
        try:
            conn, prompt, hostname = open_session(ctx, d, params)
            try:
                ctx.check_stop()
                output = conn.send_command("show cdp neighbor detail", read_timeout=90)
            finally:
                conn.disconnect()
            save_device_log(ctx, hostname, d["host"], output)
            rows = parse_blocks(output, hostname, d["site"])
            if not rows:
                rows = [{"Device Switch": hostname, "Device ID": "(no CDP neighbours)", "IP address": d["host"],
                         "Platform": "", "Interface": "", "Port ID": "", "Version": "", "Site": d["site"],
                         "raw_output": output}]
            for r in rows:
                ctx.add_row(r)
            ok["n"] += 1
            ctx.summary(f"Total {ok['n']}/{len(devices)}")
        except Exception as e:
            if ctx.stop_requested:
                return
            ctx.log(f"Error connecting to {d['host']}: {e}", "ERROR")
            ctx.add_row({"Device Switch": d["host"], "Device ID": "N/A", "IP address": d["host"], "Platform": "N/A",
                         "Interface": "N/A", "Port ID": "N/A", "Version": "N/A", "Site": d["site"],
                         "raw_output": f"Error connecting to {d['host']}: {e}"})

    ctx.map_parallel(devices, work, params.get("threads", 10))
    ctx.info("CDP inventory collection finished.")
