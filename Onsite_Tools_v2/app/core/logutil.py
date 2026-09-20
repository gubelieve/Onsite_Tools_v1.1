"""Per-tool file logging and run directories (same layout as v1.1: logs/<tool>/...)."""
import logging
import os
import re
from datetime import datetime

from .paths import LOGS_DIR

_loggers = {}


def tool_logger(tool_id: str) -> logging.Logger:
    """Return a logger that appends to logs/<tool_id>/<tool_id>_<YYYY-MM-DD>.log."""
    date_str = datetime.now().strftime("%Y-%m-%d")
    key = (tool_id, date_str)
    if key in _loggers:
        return _loggers[key]
    logger = logging.getLogger(f"onsite.{tool_id}")
    logger.setLevel(logging.INFO)
    logger.propagate = False
    for h in list(logger.handlers):
        logger.removeHandler(h)
    try:
        d = os.path.join(LOGS_DIR, tool_id)
        os.makedirs(d, exist_ok=True)
        handler = logging.FileHandler(os.path.join(d, f"{tool_id}_{date_str}.log"), mode="a", encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(asctime)s - %(levelname)s - %(message)s"))
        logger.addHandler(handler)
    except Exception:
        logger.addHandler(logging.NullHandler())
    _loggers[key] = logger
    return logger


def make_run_dir(tool_id: str) -> str:
    """Create logs/<tool_id>/<YYYY-MM-DD_HHMMSS>/ and return it."""
    ts = datetime.now().strftime("%Y-%m-%d_%H%M%S")
    d = os.path.join(LOGS_DIR, tool_id, ts)
    os.makedirs(d, exist_ok=True)
    return d


def safe_name(text: str, keep: str = "._-") -> str:
    text = str(text or "").strip()
    return re.sub(r"[^A-Za-z0-9" + re.escape(keep) + r"]+", "_", text) or "unnamed"


def now_hms() -> str:
    return datetime.now().strftime("%H:%M:%S")


def now_stamp() -> str:
    return datetime.now().strftime("%Y-%m-%d_%H%M%S")


def write_text(path: str, text: str):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
