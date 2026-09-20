"""Tool registry.

Every module in this package that defines a ``TOOL`` dict and a ``run(ctx, params)``
function is registered automatically and shows up in the sidebar. Optional:

* ``ACTIONS``      - dict of ``name -> fn(params) -> json`` (synchronous helpers used by
                     the form, e.g. listing saved commands or detecting the local IP)
* ``JOB_ACTIONS``  - dict of ``name -> fn(job, params) -> json`` (post-run helpers that
                     work on a finished job, e.g. building an HTML report)

TOOL keys: id, name, category, description, fields, columns, runs, notes, order.
"""
import importlib
import pkgutil
import traceback

from ..core.paths import load_settings

_settings = load_settings()

# Devices come from the Site Inventory menu (app/core/inventory.py) - tools never upload device CSVs.
INVENTORY_FIELDS = [
    {"name": "inventory_list", "label": "Device list (Site Inventory)", "type": "select", "default": "All",
     "width": "half", "source": {"type": "inventory_lists", "all_label": "All"},
     "help": "Lists are imported in the Site Inventory menu."},
    {"name": "site", "label": "Site", "type": "select", "default": "All", "width": "half",
     "source": {"type": "inventory_sites", "field": "inventory_list", "all_label": "All"}, "show_count": True},
]

COMMON_DEVICE_FIELDS = INVENTORY_FIELDS + [
    {"name": "username", "label": "Username", "type": "text", "required": True, "width": "half",
     "default": _settings.get("default_username", ""), "remember": True},
    {"name": "password", "label": "Password", "type": "password", "required": True, "width": "half",
     "default": _settings.get("default_password", ""), "remember": True},
    {"name": "device_type", "label": "Device type", "type": "select", "width": "half",
     "default": _settings.get("default_device_type", "autodetect"), "options": "device_types",
     "help": "autodetect = let netmiko guess. A Device_Type stored in Site Inventory overrides this."},
    {"name": "threads", "label": "Max threads", "type": "number", "min": 1, "max": 100, "width": "half",
     "default": _settings.get("default_threads", 10)},
]

_registry = {}
_load_errors = {}


def _discover():
    if _registry:
        return
    for mod in pkgutil.iter_modules(__path__):
        if mod.name.startswith("_"):
            continue
        try:
            m = importlib.import_module(f"{__name__}.{mod.name}")
        except Exception as e:  # keep the app usable even if one tool fails to import
            _load_errors[mod.name] = f"{e}\n{traceback.format_exc()}"
            continue
        tool = getattr(m, "TOOL", None)
        run = getattr(m, "run", None)
        if not isinstance(tool, dict) or not callable(run):
            continue
        tool = dict(tool)
        tool.setdefault("id", mod.name)
        tool.setdefault("name", mod.name.replace("_", " ").title())
        tool.setdefault("category", "Other")
        tool.setdefault("description", "")
        tool.setdefault("fields", [])
        tool.setdefault("columns", [])
        tool.setdefault("runs", [{"id": "run", "label": "Run"}])
        tool.setdefault("order", 100)
        tool["run"] = run
        tool["actions"] = getattr(m, "ACTIONS", {}) or {}
        tool["job_actions"] = getattr(m, "JOB_ACTIONS", {}) or {}
        tool["job_action_defs"] = tool.get("job_action_defs", [])
        _registry[tool["id"]] = tool


def all_tools():
    _discover()
    return sorted(_registry.values(), key=lambda t: (t.get("order", 100), t["name"]))


def get_tool(tool_id):
    _discover()
    return _registry.get(tool_id)


def load_errors():
    _discover()
    return dict(_load_errors)


def public(tool):
    """Metadata safe to send to the browser (no callables)."""
    return {k: v for k, v in tool.items() if k not in ("run", "actions", "job_actions")} | {
        "actions": sorted(tool["actions"].keys()),
        "job_actions": tool.get("job_action_defs", []),
    }
