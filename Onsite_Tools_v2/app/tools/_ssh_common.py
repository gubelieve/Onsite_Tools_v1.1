"""Shared helpers for SSH-based device tools (not a tool itself: name starts with '_')."""
import os
import re
from datetime import datetime

from ..core import inventory
from ..core.logutil import safe_name
from ..core.netutil import classify_error, connect, prepare
from ..core.paths import load_settings


def ssh_timeout():
    try:
        return int(load_settings().get("ssh_timeout", 20))
    except Exception:
        return 20


def load_devices_or_fail(ctx, params):
    return inventory.devices_for(ctx, params)


def device_type_for(device, params):
    t = (device.get("device_type") or "").strip()
    if t and t.lower() != "autodetect":
        return t
    return params.get("device_type") or "autodetect"


def open_session(ctx, device, params):
    """Connect + disable paging. Returns (conn, prompt, hostname)."""
    conn = connect(device["host"], params.get("username", ""), params.get("password", ""),
                   device_type_for(device, params), timeout=ssh_timeout())
    prompt, hostname = prepare(conn)
    ctx.log(f"[SSH CONNECTED] {device['host']} ({hostname}) type={getattr(conn, 'detected_type', '?')}")
    return conn, prompt, hostname


def save_device_log(ctx, hostname, host, text, prefix=""):
    ts = datetime.now().strftime("%Y-%m-%d_%H%M%S")
    fname = f"{prefix}{safe_name(hostname)}-{safe_name(host)}_{ts}.log"
    path = os.path.join(ctx.run_dir, fname)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return path


def error_status(exc):
    return classify_error(exc)


def strip_prompt(prompt):
    return re.sub(r"[#>]\s*$", "", prompt or "").strip()
