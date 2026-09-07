"""LLDP Inventory - parse 'show lldp neighbor detail' from every device."""
import re

from . import COMMON_DEVICE_FIELDS
from ._ssh_common import load_devices_or_fail, open_session, save_device_log

FIELDS = ["Local Intf", "Chassis id", "Port id", "System Name", "F/W revision", "S/W revision",
          "Serial number", "Manufacturer", "Model"]

TOOL = {
    "id": "lldp_inventory",
    "name": "LLDP Inventory",
    "category": "Inventory",
    "order": 32,
    "description": "Collect LLDP neighbours (chassis/port id, system name, revisions, serial, model) from each device.",
    "fields": COMMON_DEVICE_FIELDS,
    "columns": ["Device Switch"] + FIELDS + ["Site", "raw_output"],
    "runs": [{"id": "run", "label": "Run"}],
}


def parse_blocks(output, hostname, site):
    rows = []
    for block in re.split(r"-{3,}\n", output):
        if not block.strip() or ("Chassis id" not in block and "Local Intf" not in block):
            continue
        r = {"Device Switch": hostname, "Site": site, "raw_output": block.strip()}
        for f in FIELDS:
            m = re.search(re.escape(f) + r": ([^\n]+)", block)
            r[f] = m.group(1).strip() if m else ""
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
                output = conn.send_command("show lldp neighbor detail", read_timeout=90)
                ctx.log(f"[COMMAND EXECUTED] {d['host']} ({hostname}) 'show lldp neighbor detail'")
            finally:
                conn.disconnect()
            save_device_log(ctx, hostname, d["host"], output)
            rows = parse_blocks(output, hostname, d["site"])
            if not rows:
                r = {"Device Switch": hostname, "Site": d["site"], "raw_output": output}
                r.update({f: "" for f in FIELDS})
                r["System Name"] = "(no LLDP neighbours)"
                rows = [r]
            for r in rows:
                ctx.add_row(r)
            ok["n"] += 1
            ctx.summary(f"Total {ok['n']}/{len(devices)}")
        except Exception as e:
            if ctx.stop_requested:
                return
            ctx.log(f"Error connecting to {d['host']}: {e}", "ERROR")
            r = {"Device Switch": d["host"], "Site": d["site"], "raw_output": f"Error connecting to {d['host']}: {e}"}
            r.update({f: "N/A" for f in FIELDS})
            ctx.add_row(r)

    ctx.map_parallel(devices, work, params.get("threads", 10))
    ctx.info("LLDP inventory collection finished.")
