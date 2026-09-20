"""Client Status Checker - look for a client MAC on every switch (MAC table, then ARP)."""
from . import COMMON_DEVICE_FIELDS
from ._ssh_common import error_status, load_devices_or_fail, open_session

TOOL = {
    "id": "client_status_checker",
    "name": "Client Status Checker",
    "category": "SSH Tools",
    "order": 20,
    "description": "Check on which device a client MAC address is seen (show mac address-table, then show ip arp).",
    "fields": COMMON_DEVICE_FIELDS + [
        {"name": "mac", "label": "Client MAC address", "type": "text", "required": True,
         "placeholder": "e.g. aabb.ccdd.eeff"},
    ],
    "columns": ["Site", "Checked On (IP)", "Hostname", "Client MAC", "Status", "Output"],
    "runs": [{"id": "run", "label": "Check Status"}],
}


def run(ctx, params):
    mac = (params.get("mac") or "").strip().lower()
    devices = load_devices_or_fail(ctx, params)
    if not devices:
        return
    ctx.set_columns(TOOL["columns"])
    keys = {d["host"]: ctx.add_row({"Site": d["site"], "Checked On (IP)": d["host"], "Hostname": d.get("hostname", ""),
                                    "Client MAC": mac, "Status": "Pending...", "Output": ""}) for d in devices}
    found = {"n": 0}

    def work(d):
        key = keys[d["host"]]
        try:
            conn, prompt, hostname = open_session(ctx, d, params)
            try:
                out = conn.send_command(f"show mac address-table address {mac}", read_timeout=60)
                status = "Disconnected"
                text = f"--- show mac address-table address {mac} ---\n{out}\n"
                if mac in out.lower():
                    status = "Connected"
                else:
                    arp = conn.send_command(f"show ip arp {mac}", read_timeout=60)
                    text += f"--- show ip arp {mac} ---\n{arp}\n"
                    if mac in arp.lower():
                        status = "Connected (ARP)"
            finally:
                conn.disconnect()
            if status.startswith("Connected"):
                found["n"] += 1
            ctx.update_row(key, Hostname=hostname, Status=status, Output=text)
        except Exception as e:
            ctx.log(f"SSH error for {d['host']}: {e}", "ERROR")
            ctx.update_row(key, Status=error_status(e), Output=str(e))

    ctx.map_parallel(devices, work, params.get("threads", 10))
    ctx.summary(f"MAC {mac} found on {found['n']} device(s)")
    ctx.info("Client status check finished.")
