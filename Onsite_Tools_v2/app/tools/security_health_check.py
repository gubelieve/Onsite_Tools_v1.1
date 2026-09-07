"""Security Health Check - compare saved device logs against templates/shc_template.csv."""
import os
import re
from datetime import datetime

from ..core import csvutil
from ..core.logutil import make_run_dir
from ..core.paths import TEMPLATES_DIR
from ._files_common import collect_log_files, display_name

TOOL = {
    "id": "security_health_check",
    "name": "Security Health Check",
    "category": "Log Analysis",
    "order": 51,
    "description": "Read device log files (show version / show inventory / show run), detect model & version, "
                   "then look up every configuration item listed as a column in the template CSV.",
    "fields": [
        {"name": "log_folder", "label": "Log folder", "type": "path", "kind": "folder",
         "help": "Folder scanned recursively for *.log files (server-side path)."},
        {"name": "log_files", "label": "...or upload log files", "type": "files", "accept": ".log,.txt"},
        {"name": "template_file", "label": "Template CSV", "type": "path", "kind": "file",
         "default": os.path.join(TEMPLATES_DIR, "shc_template.csv"), "template": "shc_template.csv",
         "help": "Columns: brand, zone, model, then one column per config command to check."},
    ],
    "columns": ["IP_Address", "Hostname", "Model Detect", "Version Detect"],
    "runs": [{"id": "run", "label": "Generate Report"}],
}

EXCLUDE = ("brand", "zone", "model")


def extract_info_from_filename(path):
    name = re.sub(r"\.(log|txt)$", "", os.path.basename(path), flags=re.IGNORECASE)
    ipm = re.search(r"(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])", name)
    ip = ipm.group(1) if ipm else "Unknown"
    host = name.replace(ip, "") if ipm else name
    host = re.sub(r"^stage_\d+_", "", host, flags=re.IGNORECASE)
    for pat in (r"_\d{4}-\d{2}-\d{2}_\d{6}$", r"_\d{8}_\d{6}$", r"_\d{4}-\d{2}-\d{2}$", r"_\d{8}$", r"_\d{6}$",
                r"_\d{6}_\d{2}$"):
        host = re.sub(pat, "", host)
    host = re.sub(r"^[-_\s]+|[-_\s]+$", "", host)
    host = re.sub(r"[-_\s]+", "_", host)
    if not host or host == "_":
        for part in re.split(r"[-_\s]+", name):
            if part and not re.match(r"^\d+$", part) and not re.match(r"^\d{1,3}(\.\d{1,3}){3}$", part) \
                    and part.lower() not in ("stage", "log", "txt"):
                host = part
                break
        host = host or "Unknown"
    return ip, host


MODEL_PATTERNS = [
    r"PID:\s*([^\s,\n]+)", r"Model\s+Number:\s*([^\n]+)", r"Product\s+name:\s*([^\n]+)", r"Model:\s*([^\n]+)",
    r'NAME:\s*"([^"]+)"', r'DESCR:\s*"([^"]+)"', r"Product\s+ID:\s*([^\n]+)", r"Model\s+Number\s*\(PID\):\s*([^\n]+)",
]
VERSION_PATTERNS = [
    r"Cisco\s+IOS\s+XE\s+Software[^,]*,\s+Version\s+(\d+\.\d+\.\d+)",
    r"Cisco\s+IOS\s+Software[^,]*,\s+Version\s+(\d+\.\d+\.?\d*)",
    r"VRP\s+\(R\)\s+software[^,]*,\s+Version\s+(\d+\.\d+\.?\d*)",
    r"Software\s+Version\s+(\d+\.\d+\.?\d*)", r"System\s+version:\s+(\d+\.\d+\.?\d*)",
    r"Version\s+(\d+\.\d+\.?\d*)", r"Version\s+([^\s,\n\(\)]+)",
]


def extract_model(content):
    for pat in MODEL_PATTERNS:
        m = re.search(pat, content, re.IGNORECASE)
        if m:
            model = re.sub(r"\s+", " ", m.group(1).strip()).strip("\"'")
            if model:
                return model
    return None


def extract_version(content):
    for pat in VERSION_PATTERNS:
        m = re.search(pat, content, re.IGNORECASE)
        if m:
            v = re.sub(r"\s+", " ", m.group(1).strip())
            v = re.sub(r"\s*\([^)]*\)\s*$", "", v)
            v = re.sub(r",\s*$", "", v).strip()
            if v:
                return v
    return None


def search_config(content, column):
    name = column.replace(".*", "").strip()
    if not name:
        return None
    esc = re.escape(name)
    # 1) the command exactly on its own line (e.g. "no ip finger") -> present
    if re.search(rf"^[ \t]*{esc}[ \t]*$", content, re.MULTILINE | re.IGNORECASE):
        return name
    # 2) command at start of line followed by its arguments (same line only)
    pats = [rf"^[ \t]*{esc}[ \t]+([^\n\r]+)$", rf"{esc}[ \t]+([^\n\r]+)", rf"{esc}[ \t]*:[ \t]*([^\n\r]+)"]
    for pat in pats:
        for m in re.findall(pat, content, re.MULTILINE | re.IGNORECASE):
            v = re.sub(r"\s*!.*$", "", (m or "").strip()).strip()
            if v:
                return v
    return None


def run(ctx, params):
    files = collect_log_files(ctx, params)
    if not files:
        ctx.error("No .log files found. Give a folder path or upload log files.")
        return
    template = (params.get("template_file") or "").strip().strip('"') or os.path.join(TEMPLATES_DIR, "shc_template.csv")
    if not os.path.isfile(template):
        ctx.error(f"Template file not found: {template}")
        return
    tfields, trows = csvutil.read_csv(template)
    check_cols = [c for c in tfields if c and c.lower() not in EXCLUDE]
    columns = ["IP_Address", "Hostname", "Model Detect", "Version Detect", "Template Match"] + check_cols
    ctx.set_columns(columns)
    ctx.progress(0, len(files))
    results = []
    for path in files:
        ctx.check_stop()
        ip, host = extract_info_from_filename(path)
        try:
            with open(path, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()
            model = extract_model(content) or ""
            version = extract_version(content) or ""
            match = None
            if model:
                for tr in trows:
                    tm = (tr.get("model") or "").strip()
                    if tm and (tm.lower() == model.lower() or tm.lower() in model.lower() or model.lower() in tm.lower()):
                        match = tr
                        break
            row = {"IP_Address": ip, "Hostname": host, "Model Detect": model, "Version Detect": version,
                   "Template Match": (match.get("model") if match else "(none)")}
            for c in check_cols:
                row[c] = (search_config(content, c) or "") if match else ""
            ctx.add_row(row)
            results.append(row)
            ctx.log(f"Processed {host} ({ip}) from {display_name(path)}")
        except Exception as e:
            ctx.log(f"Error processing {path}: {e}", "ERROR")
            ctx.warn(f"Error processing {display_name(path)}: {e}")
        ctx.step()
    out_dir = make_run_dir("security_health_check")
    out = os.path.join(out_dir, f"shc_result_{datetime.now().strftime('%d%m%y_%H%M%S')}.csv")
    csvutil.write_csv(out, columns, results)
    ctx.artifact(os.path.basename(out), out)
    ctx.summary(f"{len(results)} device(s) checked against {len(check_cols)} items")
    ctx.info(f"CSV exported successfully with {len(results)} results: {out}")
