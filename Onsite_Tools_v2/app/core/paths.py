"""Project paths and settings.

Everything is resolved relative to the project root (the folder that contains
``run.bat``), so the whole folder can be copied anywhere and still work.
"""
import json
import os
import sys

if getattr(sys, "frozen", False):
    BASE_DIR = os.path.dirname(os.path.abspath(sys.executable))
else:
    BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

APP_DIR = os.path.join(BASE_DIR, "app")
STATIC_DIR = os.path.join(BASE_DIR, "static")
TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")
LOGS_DIR = os.path.join(BASE_DIR, "logs")
UPLOADS_DIR = os.path.join(BASE_DIR, "uploads")
EXPORTS_DIR = os.path.join(BASE_DIR, "exports")
SCREENSHOTS_DIR = os.path.join(BASE_DIR, "screenshots")
SETTINGS_FILE = os.path.join(BASE_DIR, "settings.json")

DEFAULT_SETTINGS = {
    "host": "127.0.0.1",
    "port": 8088,
    "open_browser": True,
    "default_username": "",
    "default_password": "",
    "default_device_type": "autodetect",
    "default_threads": 10,
    "snmp_community": "",
    "ssh_timeout": 20,
}


def ensure_dirs():
    for d in (LOGS_DIR, UPLOADS_DIR, EXPORTS_DIR, SCREENSHOTS_DIR, TEMPLATES_DIR):
        os.makedirs(d, exist_ok=True)


def load_settings():
    settings = dict(DEFAULT_SETTINGS)
    try:
        if os.path.exists(SETTINGS_FILE):
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                settings.update({k: v for k, v in data.items() if v is not None})
    except Exception:
        pass
    return settings


def public_settings():
    """Settings that are safe/useful to send to the browser."""
    s = load_settings()
    return {
        "default_username": s.get("default_username", ""),
        "default_password": s.get("default_password", ""),
        "default_device_type": s.get("default_device_type", "autodetect"),
        "default_threads": s.get("default_threads", 10),
        "snmp_community": s.get("snmp_community", ""),
        "base_dir": BASE_DIR,
        "logs_dir": LOGS_DIR,
        "exports_dir": EXPORTS_DIR,
    }
