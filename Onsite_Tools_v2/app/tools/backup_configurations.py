"""Backup Configurations - run a set of saved show commands on every device and keep the output."""
import csv
import os

from ..core.netutil import DEVICE_TYPES
from ..core.paths import COMMANDS_FILE
from . import COMMON_DEVICE_FIELDS
from ._ssh_common import error_status, load_devices_or_fail, open_session, save_device_log

TOOL = {
    "id": "backup_configurations",
    "name": "Backup Configurations",
    "category": "SSH Tools",
    "order": 10,
    "description": "Run the selected commands from the command library on every device and save each "
                   "device's output to logs/backup_configurations/<run>/.",
    "fields": COMMON_DEVICE_FIELDS + [
        {"name": "commands", "label": "Commands", "type": "checklist", "required": True,
         "source": {"type": "action", "action": "list_commands"},
         "add": {"action": "add_command", "label": "Add command",
                 "fields": [
                     {"name": "command", "label": "Command", "type": "text", "required": True},
                     {"name": "device_type", "label": "Device Type", "type": "select", "options": "device_types",
                      "default": "cisco_ios"},
                     {"name": "type", "label": "Type", "type": "text"}]},
         "remove": {"action": "remove_command"}},
    ],
    "columns": ["Site", "IP Address", "Hostname", "Status", "Output"],
    "runs": [{"id": "run", "label": "Run Backup"}],
}


def _read_commands():
    if not os.path.exists(COMMANDS_FILE):
        return []
    with open(COMMANDS_FILE, "r", encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    out = []
    for r in rows:
        cmd = (r.get("Command") or "").strip()
        if not cmd:
            continue
        dt = (r.get("Device Type") or r.get("DeviceType") or "").strip()
        out.append({"Command": cmd, "Device Type": dt, "Type": (r.get("Type") or "").strip()})
    return out


def _write_commands(rows):
    with open(COMMANDS_FILE, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["Command", "Device Type", "Type"])
        w.writeheader()
        w.writerows(rows)


def list_commands(params=None):
    return [{"value": r["Command"], "label": f"{r['Command']} ({r['Device Type']})" if r["Device Type"] else r["Command"]}
            for r in _read_commands()]


def add_command(params):
    cmd = (params.get("command") or "").strip()
    if not cmd:
        raise ValueError("Command is required")
    rows = _read_commands()
    if any(r["Command"] == cmd for r in rows):
        return {"ok": True, "message": "Command already exists"}
    dt = params.get("device_type") or "cisco_ios"
    if dt not in DEVICE_TYPES:
        dt = "cisco_ios"
    rows.append({"Command": cmd, "Device Type": dt, "Type": (params.get("type") or "").strip()})
    _write_commands(rows)
    return {"ok": True, "message": f"Saved '{cmd}' to commands.csv"}


def remove_command(params):
    cmd = (params.get("value") or "").strip()
    rows = [r for r in _read_commands() if r["Command"] != cmd]
    _write_commands(rows)
    return {"ok": True}


ACTIONS = {"list_commands": list_commands, "add_command": add_command, "remove_command": remove_command}


def run(ctx, params):
    commands = params.get("commands") or []
    if isinstance(commands, str):
        commands = [c for c in commands.splitlines() if c.strip()]
    if not commands:
        ctx.error("Please select at least one command to run.")
        return
    devices = load_devices_or_fail(ctx, params)
    if not devices:
        return
    ctx.set_columns(TOOL["columns"], ["Site", "IP Address", "Hostname", "Status", "Log File", "Output"])
    keys = {}
    for d in devices:
        keys[d["host"]] = ctx.add_row({"Site": d["site"], "IP Address": d["host"], "Hostname": d.get("hostname", ""),
                                       "Status": "Pending...", "Output": "", "Log File": ""})
    success = {"n": 0}
    ctx.summary(f"Total 0/{len(devices)}")

    def work(d):
        key = keys[d["host"]]
        if ctx.stop_requested:
            ctx.update_row(key, Status="Stopped by user")
            return
        ctx.update_row(key, Status="Connecting...")
        try:
            conn, prompt, hostname = open_session(ctx, d, params)
            try:
                ctx.update_row(key, Hostname=hostname, Status="Running commands...")
                full = ""
                for cmd in commands:
                    if ctx.stop_requested:
                        ctx.update_row(key, Status="Stopped by user", Output=full)
                        return
                    full += f"--- {cmd} ---\n"
                    full += conn.send_command(cmd, read_timeout=120) + "\n"
            finally:
                conn.disconnect()
            path = save_device_log(ctx, hostname, d["host"], full)
            success["n"] += 1
            ctx.update_row(key, Status="Success", Output=full, **{"Log File": path})
            ctx.summary(f"Total {success['n']}/{len(devices)}")
        except Exception as e:
            ctx.log(f"SSH connection or command error for {d['host']}: {e}", "ERROR")
            ctx.update_row(key, Status=error_status(e), Output=str(e))

    ctx.map_parallel(devices, work, params.get("threads", 10))
    ctx.info(f"Backup process has completed. Success {success['n']}/{len(devices)}.")
