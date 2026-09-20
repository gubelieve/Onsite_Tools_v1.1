"""Interface Report - parse saved running-configs (.log) into an interface CSV."""
import os
import re
from datetime import datetime

from ..core import csvutil
from ..core.paths import EXPORTS_DIR
from ._files_common import collect_log_files

TOOL = {
    "id": "interface_report",
    "name": "Interface Report",
    "category": "Log Analysis",
    "order": 50,
    "description": "Parse 'show running-config' log files (e.g. from Config Devices) and build a per-interface "
                   "report: switchport mode, description, BPDU guard, VLANs, dot1x template, VLAN names.",
    "fields": [
        {"name": "log_folder", "label": "Log folder", "type": "path", "kind": "folder",
         "help": "Folder scanned recursively for *.log files (server-side path)."},
        {"name": "log_files", "label": "...or upload log files", "type": "files", "accept": ".log,.txt",
         "help": "Used when no folder is given."},
        {"name": "output_name", "label": "Output CSV name", "type": "text", "default": "interface_report.csv",
         "width": "half"},
    ],
    "columns": ["hostname", "interface", "switchport_mode", "description", "bpdu_enable",
                "device-tracking attach-policy", "data vlan", "voice vlan", "dot1x authen", "ip pool data",
                "voice pool data"],
    "runs": [{"id": "run", "label": "Generate Report"}],
}


def hostname_from_filename(path):
    h = os.path.basename(path)
    h = re.sub(r"\.(log|txt)$", "", h, flags=re.IGNORECASE)
    for pat in (r"_\d{4}-\d{2}-\d{2}_\d{6}$", r"_\d{8}_\d{6}$", r"_\d{4}-\d{2}-\d{2}$", r"_\d{8}$"):
        h = re.sub(pat, "", h)
    return h


def extract_vlan_info(content):
    info = {}
    for vid, cfg in re.findall(r"^vlan\s+(\d+)\s*\n(.*?)(?=^vlan\s+\d+|^interface\s+|^!|$)", content,
                               re.MULTILINE | re.DOTALL):
        m = re.search(r"^\s*name\s+(.+)$", cfg, re.MULTILINE)
        if m:
            info[vid] = m.group(1).strip()
    return info


def parse_interface_block(block, hostname, vlan_info):
    lines = block.strip().split("\n")
    name = lines[0].strip() if lines else ""
    if not name:
        return None
    info = {"hostname": hostname, "interface": name, "switchport_mode": "unknown", "description": "",
            "bpdu_enable": "", "device-tracking attach-policy": "", "data vlan": "unknown", "voice vlan": "unknown",
            "dot1x authen": "", "ip pool data": "", "voice pool data": ""}
    for line in lines[1:]:
        line = line.strip()
        if re.match(r"^ip\s+address\s+", line):
            info["switchport_mode"] = "route port"
        elif re.match(r"^switchport\s+mode\s+", line):
            if "access" in line:
                info["switchport_mode"] = "access"
            elif "trunk" in line:
                info["switchport_mode"] = "trunk"
        elif re.match(r"^description\s+", line):
            info["description"] = line[len("description"):].strip()
        elif re.match(r"^spanning-tree\s+bpduguard\s+enable", line):
            info["bpdu_enable"] = "spanning-tree bpduguard enable"
        elif re.match(r"^device-tracking\s+attach-policy\s+", line):
            info["device-tracking attach-policy"] = re.sub(r"^device-tracking\s+attach-policy\s+", "", line).strip()
        elif re.match(r"^switchport\s+access\s+vlan\s+", line):
            m = re.match(r"^switchport\s+access\s+vlan\s+(\d+)$", line)
            if m:
                info["data vlan"] = m.group(1)
        elif re.match(r"^switchport\s+voice\s+vlan\s+", line):
            m = re.match(r"^switchport\s+voice\s+vlan\s+(\d+)$", line)
            if m:
                info["voice vlan"] = m.group(1)
        elif re.match(r"^source\s+template\s+", line):
            info["dot1x authen"] = re.sub(r"^source\s+template\s+", "", line).strip()
    if vlan_info:
        if info["data vlan"] in vlan_info:
            info["ip pool data"] = vlan_info[info["data vlan"]]
        if info["voice vlan"] in vlan_info:
            info["voice pool data"] = vlan_info[info["voice vlan"]]
    return info


def parse_log_file(path, hostname):
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        content = f.read()
    vlan_info = extract_vlan_info(content)
    out = []
    for block in re.split(r"^interface\s+", content, flags=re.MULTILINE)[1:]:
        info = parse_interface_block(block, hostname, vlan_info)
        if info:
            out.append(info)
    return out


def run(ctx, params):
    files = collect_log_files(ctx, params)
    if not files:
        ctx.error("No .log files found. Give a folder path or upload log files.")
        return
    ctx.set_columns(TOOL["columns"])
    ctx.progress(0, len(files))
    all_rows = []
    for i, path in enumerate(files):
        ctx.check_stop()
        host = hostname_from_filename(path)
        try:
            rows = parse_log_file(path, host)
            for r in rows:
                ctx.add_row(r)
            all_rows.extend(rows)
            ctx.log(f"Processed {len(rows)} interfaces from {host}")
        except Exception as e:
            ctx.log(f"Error processing {path}: {e}", "ERROR")
            ctx.warn(f"Error processing {os.path.basename(path)}: {e}")
        ctx.step()
    name = (params.get("output_name") or "interface_report.csv").strip()
    if not name.lower().endswith(".csv"):
        name += ".csv"
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", name)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    out = os.path.join(EXPORTS_DIR, f"{os.path.splitext(name)[0]}_{stamp}.csv")
    csvutil.write_csv(out, TOOL["columns"], all_rows)
    ctx.artifact(os.path.basename(out), out)
    ctx.summary(f"{len(all_rows)} interfaces from {len(files)} file(s)")
    ctx.info(f"CSV exported with {len(all_rows)} interfaces: {out}")
