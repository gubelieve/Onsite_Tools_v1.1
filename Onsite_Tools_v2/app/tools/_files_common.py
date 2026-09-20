"""Helpers for tools that read local log files (folder path or uploaded files)."""
import os


def collect_log_files(ctx, params, exts=(".log", ".txt")):
    folder = (params.get("log_folder") or "").strip().strip('"')
    files = []
    if folder:
        if not os.path.isdir(folder):
            ctx.error(f"Folder not found: {folder}")
            return []
        for root, _dirs, names in os.walk(folder):
            for n in names:
                if n.lower().endswith(exts):
                    files.append(os.path.join(root, n))
        files.sort()
        ctx.log(f"Found {len(files)} log files in {folder}")
        return files
    uploaded = params.get("log_files") or []
    if isinstance(uploaded, dict):
        uploaded = [uploaded]
    for item in uploaded:
        p = item.get("path") if isinstance(item, dict) else item
        if p and os.path.isfile(p):
            files.append(p)
    return files


def display_name(item):
    """Uploaded files are renamed <stamp>_<i>_<original>; return the original name."""
    base = os.path.basename(item)
    parts = base.split("_", 2)
    if len(parts) == 3 and parts[0].isdigit() and parts[1].isdigit():
        return parts[2]
    return base
