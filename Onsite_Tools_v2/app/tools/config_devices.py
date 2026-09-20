"""Config Devices - push/verify commands per device (v1.1 config_devices + config_devices_v2 merged).

* Commands come from the form textarea, or per device from a ``command`` column that was
  imported into Site Inventory (one cell may hold several lines).
* Verify mode runs the commands as-is; Config mode enters configuration mode first.
* One result column is created per unique command (like v2), plus the full output.
* Optional "Generate Report" builds a ydata-profiling HTML report from the results.
"""
import os
import re
from datetime import datetime

from ..core import inventory
from ..core.paths import EXPORTS_DIR
from . import COMMON_DEVICE_FIELDS
from ._ssh_common import open_session, save_device_log

TOOL = {
    "id": "config_devices",
    "name": "Config Devices",
    "category": "SSH Tools",
    "order": 11,
    "description": "Run verification or configuration commands on many devices from Site Inventory. Commands come "
                   "from the text box, or per device from an imported 'command' column. Each command gets its own "
                   "result column.",
    "fields": COMMON_DEVICE_FIELDS + [
        {"name": "commands", "label": "Commands (one per line)", "type": "textarea", "rows": 5,
         "placeholder": "show version\nshow ip interface brief",
         "help": "Sent to every selected device."},
        {"name": "per_device_commands", "label": "Use per-device 'command' column from Site Inventory",
         "type": "checkbox", "default": False, "width": "half",
         "help": "Import a list with a 'command' column (template: device_list_command_template.csv). Devices "
                 "without a command fall back to the text box."},
        {"name": "mode", "label": "Mode", "type": "select", "default": "Verify mode",
         "options": ["Verify mode", "Config mode"], "width": "half",
         "help": "Config mode enters 'configure terminal' before sending the commands."},
    ],
    "columns": ["IP Address", "Hostname", "Status", "Failure Reason", "Disconnect Status", "Output"],
    "runs": [{"id": "run", "label": "Run"}],
    "job_action_defs": [{"id": "profile_report", "label": "Generate Report (HTML)",
                         "help": "Needs the optional ydata-profiling package."}],
}

BASE_COLUMNS = ["IP Address", "Hostname", "Status", "Failure Reason", "Disconnect Status"]


def _commands_for(device, params, per_device):
    text = ""
    if per_device:
        text = next((v for k, v in device["raw"].items() if k.lower() in ("command", "commands")), "") or ""
    text = text or params.get("commands") or ""
    return [c.strip() for c in str(text).splitlines() if c.strip()]


def run(ctx, params):
    cmd_col = bool(params.get("per_device_commands"))
    devices = inventory.devices_for(ctx, params)
    if not devices:
        return
    if not any(_commands_for(d, params, cmd_col) for d in devices):
        ctx.error("Please enter a command to run (or import a list with a 'command' column and tick the option).")
        return
    mode = params.get("mode") or "Verify mode"
    all_cmds = []
    for d in devices:
        for c in _commands_for(d, params, cmd_col):
            if c not in all_cmds:
                all_cmds.append(c)
    columns = BASE_COLUMNS + all_cmds + ["Output"]
    ctx.set_columns(columns, BASE_COLUMNS + ["Site"] + all_cmds + ["Output", "Log File"])
    keys = {}
    for d in devices:
        row = {c: "-" for c in columns}
        row.update({"IP Address": d["host"], "Hostname": d.get("hostname", ""), "Status": "Pending", "Site": d["site"],
                    "Output": "", "Log File": ""})
        keys[d["host"]] = ctx.add_row(row)
    ok = {"n": 0}

    def work(d):
        key = keys[d["host"]]
        commands = _commands_for(d, params, cmd_col)
        if not commands:
            ctx.update_row(key, Status="Skipped", **{"Failure Reason": "No command"})
            return
        disconnect_status = "Success"
        try:
            conn, prompt, hostname = open_session(ctx, d, params)
            ctx.update_row(key, Status="Pass", Hostname=hostname)
            full = ""
            status = "Success"
            outputs = {}
            try:
                in_config = mode == "Config mode"
                if in_config:
                    try:
                        conn.config_mode()
                    except Exception as ce:
                        status = f"Config Mode Error: {ce}"
                        full += f"[Config Mode Error: {ce}]\n"
                for cmd in commands:
                    if ctx.stop_requested:
                        status = "Stopped by user"
                        full += "[Stopped by user]\n"
                        break
                    full += f"--- {cmd} ---\n"
                    low = cmd.lower()
                    try:
                        if low in ("conf t", "configure terminal"):
                            expect = r"\(config[^\)]*\)#"
                            in_config = True
                        elif low in ("end", "exit"):
                            expect = re.escape(prompt)
                            in_config = False
                        elif in_config:
                            expect = r"\(config[^\)]*\)#|" + re.escape(prompt)
                        else:
                            expect = re.escape(prompt)
                        out = conn.send_command(cmd, expect_string=expect, read_timeout=120)
                        full += out + "\n"
                        outputs[cmd] = out
                    except Exception as ce:
                        err = f"[Config Error: {ce}]"
                        status = f"Config Error: {ce}"
                        full += f"\n{err}\n"
                        outputs[cmd] = err
                    ctx.update_row(key, **{cmd: outputs[cmd]})
                if mode == "Config mode":
                    try:
                        conn.exit_config_mode()
                    except Exception:
                        pass
            finally:
                try:
                    conn.disconnect()
                except Exception as de:
                    disconnect_status = f"Fail: {de}"
            full = "[Command List]\n" + "\n".join(commands) + "\n\n" + full
            path = save_device_log(ctx, hostname, d["host"], full)
            if status == "Success":
                ok["n"] += 1
            ctx.update_row(key, Status=status, Output=full, **{"Failure Reason": "-" if status == "Success" else status,
                                                                "Disconnect Status": disconnect_status,
                                                                "Log File": path})
            ctx.summary(f"Total {ok['n']}/{len(devices)}")
        except Exception as e:
            ctx.log(f"SSH connection or command error for {d['host']}: {e}", "ERROR")
            ctx.update_row(key, Status="N/A", Output=f"SSH connection or command error for {d['host']}: {e}",
                           **{"Failure Reason": f"Fail: {e}", "Disconnect Status": f"Fail: {e}"})

    ctx.map_parallel(devices, work, params.get("threads", 10))
    ctx.info(f"Process has completed. Success {ok['n']}/{len(devices)}.")


# --------------------------------------------------------------- HTML report
def _profile_dataframe(job):
    import pandas as pd

    snap = job.snapshot()
    cmds = [c for c in snap["columns"] if c not in BASE_COLUMNS and c != "Output"]
    rows = []
    for r in snap["rows"]:
        row = {"IP_Address": r.get("IP Address", ""), "Hostname": r.get("Hostname", ""), "Site": r.get("Site", ""),
               "Status": r.get("Status", ""), "Failure_Reason": r.get("Failure Reason", ""),
               "Disconnect_Status": r.get("Disconnect Status", "")}
        for cmd in cmds:
            out = str(r.get(cmd, "-"))
            safe = "".join(ch for ch in cmd.replace(" ", "_").replace("/", "_").replace("|", "_")[:30]
                           if ch.isalnum() or ch in "_-")
            if out != "-":
                row[f"Cmd_{safe}_Output"] = out
                row[f"Cmd_{safe}_Length"] = len(out)
                row[f"Cmd_{safe}_LineCount"] = out.count("\n") + 1
                low = out.lower()
                row[f"Cmd_{safe}_HasError"] = int(any(k in low for k in ("error", "fail", "failed", "invalid", "denied")))
                row[f"Cmd_{safe}_HasSuccess"] = int(any(k in low for k in ("success", "ok", "complete", "up", "active")))
            else:
                row[f"Cmd_{safe}_Output"] = "-"
                row[f"Cmd_{safe}_Length"] = 0
                row[f"Cmd_{safe}_LineCount"] = 0
                row[f"Cmd_{safe}_HasError"] = 0
                row[f"Cmd_{safe}_HasSuccess"] = 0
        rows.append(row)
    df = pd.DataFrame(rows)
    if not df.empty:
        len_cols = [c for c in df.columns if c.startswith("Cmd_") and c.endswith("_Length")]
        if len_cols:
            df["Total_Commands"] = len(len_cols)
            df["Total_Output_Length"] = df[len_cols].sum(axis=1)
            df["Avg_Output_Length"] = df[len_cols].mean(axis=1).round(2)
            err = [c for c in df.columns if c.endswith("_HasError")]
            suc = [c for c in df.columns if c.endswith("_HasSuccess")]
            if err:
                df["Total_Errors"] = df[err].sum(axis=1)
            if suc:
                df["Total_Successes"] = df[suc].sum(axis=1)
    return df


def profile_report(job, params):
    try:
        from ydata_profiling import ProfileReport
    except ImportError:
        raise RuntimeError("ydata-profiling is not installed. Run:  .venv\\Scripts\\pip install ydata-profiling")
    df = _profile_dataframe(job)
    if df.empty:
        raise RuntimeError("No data available to generate report.")
    profile = ProfileReport(df, title="Device Configuration Output Analysis Report")
    name = f"config_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.html"
    path = os.path.join(EXPORTS_DIR, name)
    profile.to_file(path)
    with job.lock:
        job.artifacts.append({"name": name, "path": path})
        job._bump()
    return {"ok": True, "message": f"Report saved to {path}", "path": path,
            "url": f"/api/jobs/{job.id}/artifact/{len(job.artifacts) - 1}"}


JOB_ACTIONS = {"profile_report": profile_report}
