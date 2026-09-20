import json

from app.tools import all_tools, get_tool, load_errors, public

EXPECTED = {
    "backup_configurations", "config_devices", "upgrade_ios", "client_status_checker", "get_inventory",
    "cdp_inventory", "lldp_inventory", "snmp_inventory", "verify_snmp_user", "interface_report",
    "security_health_check", "dnac_rest_api", "dnac_port_assignment", "sd_wan_api", "capture_dnac", "calculator",
}
FIELD_TYPES = {"text", "password", "number", "textarea", "checkbox", "select", "file", "files", "path", "checklist"}


def test_all_tools_load_without_errors():
    assert load_errors() == {}
    assert {t["id"] for t in all_tools()} == EXPECTED


def test_tool_metadata_is_complete_and_serialisable():
    for tool in all_tools():
        assert callable(tool["run"])
        assert tool["name"] and tool["category"]
        names = [f["name"] for f in tool["fields"]]
        assert len(names) == len(set(names)), f"duplicate field in {tool['id']}"
        for f in tool["fields"]:
            assert f["type"] in FIELD_TYPES
        json.dumps(public(tool))  # must not contain callables


def test_no_hardcoded_credentials_in_defaults():
    for tool in all_tools():
        for f in tool["fields"]:
            if f["type"] == "password":
                assert f.get("default", "") == ""


def test_upgrade_ios_install_stage_requires_confirmation():
    runs = {r["id"]: r for r in get_tool("upgrade_ios")["runs"]}
    assert len(runs) == 6
    assert runs["stage3"]["confirm"] and runs["stage3"]["danger"]
    assert [runs[f"stage{i}"]["params"]["stage"] for i in range(6)] == list(range(6))
