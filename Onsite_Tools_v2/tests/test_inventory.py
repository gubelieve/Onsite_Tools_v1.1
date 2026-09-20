import json
import time

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.tools import all_tools, config_devices

client = TestClient(app)

STANDARD = [{"Site": "HQ", "IP_Address": "10.0.0.1", "Device_Type": "cisco_ios", "Description": "CORE-01"},
            {"Site": "BR", "IP_Address": "10.0.0.2", "Device_Type": "autodetect", "Description": "EDGE-01"},
            {"Site": "BR", "IP_Address": "", "Device_Type": "", "Description": "no ip"}]
STANDARD_FIELDS = ["Site", "IP_Address", "Device_Type", "Description"]


def test_import_merge_update_and_history(isolated_inventory):
    inv = isolated_inventory
    r = inv.import_rows(STANDARD_FIELDS, STANDARD, "", "device_list_fabric.csv")
    assert (r["list"], r["added"], r["updated"], r["skipped"]) == ("device_list_fabric", 2, 0, 1)
    # same IP again -> updated in place, new IP -> added
    r = inv.import_rows(STANDARD_FIELDS, [dict(STANDARD[0], Description="CORE-01-NEW"),
                                          {"Site": "HQ", "IP_Address": "10.0.0.3"}], "device_list_fabric", "v2.csv")
    assert (r["added"], r["updated"]) == (1, 1)
    devs = inv.devices("device_list_fabric")
    assert len(devs) == 3
    assert next(d for d in devs if d["ip"] == "10.0.0.1")["description"] == "CORE-01-NEW"
    assert inv.sites() == ["BR", "HQ"] and inv.sites("device_list_fabric") == ["BR", "HQ"]
    assert [i["filename"] for i in inv.imports()] == ["v2.csv", "device_list_fabric.csv"]
    # data really is persisted on disk
    assert len(json.load(open(inv.path, encoding="utf-8"))["devices"]) == 3


def test_import_replace_only_touches_its_own_list(isolated_inventory):
    inv = isolated_inventory
    inv.import_rows(STANDARD_FIELDS, STANDARD, "A", "a.csv")
    inv.import_rows(STANDARD_FIELDS, STANDARD, "B", "b.csv")
    r = inv.import_rows(["ip"], [{"ip": "192.168.1.1"}], "A", "a2.csv", mode="replace", default_site="LAB")
    assert (r["removed"], r["added"]) == (2, 1)
    assert [(d["ip"], d["site"]) for d in inv.devices("A")] == [("192.168.1.1", "LAB")]
    assert len(inv.devices("B")) == 2
    assert {x["name"]: x["count"] for x in inv.lists()} == {"A": 1, "B": 2}


def test_upgrade_list_aliases_and_extra_columns(isolated_inventory):
    inv = isolated_inventory
    inv.import_rows(["ip_mgmt", "hostname", "zone", "model", "brand", "device_type", "command"],
                    [{"ip_mgmt": "10.0.251.62", "hostname": "SS-SW", "zone": "Site1", "model": "C9300-24T",
                      "brand": "IOS-XE", "device_type": "cisco_ios", "command": "show clock\nshow ver"}], "upgrade", "u.csv")
    d = inv.get_devices("upgrade", "Site1")[0]
    assert (d["host"], d["hostname"], d["site"], d["device_type"]) == ("10.0.251.62", "SS-SW", "Site1", "cisco_ios")
    assert d["raw"]["Model"] == "C9300-24T" and d["raw"]["command"] == "show clock\nshow ver"
    # Config Devices can use the imported per-device command column
    assert config_devices._commands_for(d, {"commands": "show ip int br"}, True) == ["show clock", "show ver"]
    assert config_devices._commands_for(d, {"commands": "show ip int br"}, False) == ["show ip int br"]


def test_get_devices_filters_and_deduplicates_across_lists(isolated_inventory):
    inv = isolated_inventory
    inv.import_rows(STANDARD_FIELDS, STANDARD, "A", "a.csv")
    inv.import_rows(STANDARD_FIELDS, STANDARD, "B", "b.csv")
    assert [d["host"] for d in inv.get_devices("All", "All")] == ["10.0.0.1", "10.0.0.2"]
    assert [d["host"] for d in inv.get_devices("A", "BR")] == ["10.0.0.2"]
    assert inv.get_devices("A", "nowhere") == []
    assert [d["ip"] for d in inv.devices(q="core")] == ["10.0.0.1", "10.0.0.1"]


def test_manual_add_edit_delete_and_missing_ip_column(isolated_inventory):
    inv = isolated_inventory
    d = inv.upsert_device({"list": "lab", "site": "LAB", "ip": "10.9.9.9", "hostname": "R1"})
    with pytest.raises(ValueError):
        inv.upsert_device({"list": "lab", "ip": "10.9.9.9"})  # duplicate IP in the same list
    inv.upsert_device({"id": d["id"], "list": "lab", "site": "LAB2", "ip": "10.9.9.9", "hostname": "R1"})
    assert inv.devices("lab")[0]["site"] == "LAB2"
    assert inv.delete_device(d["id"]) == 1 and inv.devices() == []
    with pytest.raises(ValueError):
        inv.import_rows(["Site", "Name"], [{"Site": "x", "Name": "y"}], "bad", "bad.csv")


def test_no_tool_uploads_a_device_csv_anymore():
    device_tools = {"config_devices", "upgrade_ios", "client_status_checker", "get_inventory", "cdp_inventory",
                    "lldp_inventory", "snmp_inventory", "verify_snmp_user", "dnac_port_assignment"}
    for tool in all_tools():
        names = [f["name"] for f in tool["fields"]]
        assert "device_file" not in names
        if tool["id"] in device_tools:
            assert "inventory_list" in names and "site" in names, tool["id"]


# ------------------------------------------------------------------ REST API
def upload(name, text, **form):
    return client.post("/api/inventory/import", files={"file": (name, text.encode("utf-8-sig"), "text/csv")}, data=form)


def test_inventory_api_roundtrip():
    assert client.get("/api/inventory").json()["total"] == 0
    r = upload("device_list_lab.csv", "Site,IP_Address,Device_Type,Description\nHQ,10.0.0.1,cisco_ios,Main Router\n"
                                      "BR,10.0.0.2,autodetect,Branch\n")
    assert r.status_code == 200 and r.json()["added"] == 2 and r.json()["list"] == "device_list_lab"
    inv = client.get("/api/inventory").json()
    assert inv["total"] == 2 and inv["sites"] == ["BR", "HQ"] and inv["imports"][0]["filename"] == "device_list_lab.csv"
    assert client.get("/api/meta").json()["inventory"]["total"] == 2
    assert client.get("/api/inventory/lists").json() == ["device_list_lab"]
    assert client.get("/api/inventory/sites", params={"list": "device_list_lab"}).json() == {"sites": ["BR", "HQ"], "count": 2}
    assert client.get("/api/inventory/count", params={"list": "All", "site": "HQ"}).json() == {"count": 1}
    devs = client.get("/api/inventory/devices", params={"q": "branch"}).json()
    assert devs["total"] == 1 and devs["devices"][0]["ip"] == "10.0.0.2"
    csv_text = client.get("/api/inventory/export.csv", params={"list": "device_list_lab"}).text
    assert "List,Site,IP_Address" in csv_text and "10.0.0.2" in csv_text
    dev_id = devs["devices"][0]["id"]
    assert client.delete(f"/api/inventory/devices/{dev_id}").status_code == 200
    assert client.delete(f"/api/inventory/devices/{dev_id}").status_code == 404
    assert client.delete("/api/inventory/lists/device_list_lab").json() == {"removed": 1}


def test_inventory_api_rejects_bad_input():
    assert upload("x.csv", "Site,Name\nA,b\n").status_code == 400
    assert upload("x.csv", "IP_Address\n10.0.0.1\n", mode="wipe").status_code == 400
    assert client.post("/api/inventory/devices", json={"list": "l", "ip": ""}).status_code == 400


def wait_job(job_id):
    for _ in range(300):
        job = client.get(f"/api/jobs/{job_id}").json()
        if job["status"] not in ("queued", "running"):
            return job
        time.sleep(0.05)
    pytest.fail("job did not finish")


def test_device_tool_explains_empty_inventory():
    r = client.post("/api/tools/get_inventory/run", json={"params": {"username": "u", "password": "p"}})
    job = wait_job(r.json()["job_id"])
    assert job["rows"] == [] and "Site Inventory is empty" in job["messages"][0]["text"]


def test_device_tool_reads_devices_from_inventory(monkeypatch):
    upload("lab.csv", "Site,IP_Address,Hostname\nHQ,10.0.0.1,R1\nBR,10.0.0.2,R2\n")
    from app.tools import get_inventory

    def fake_session(ctx, device, params):
        raise RuntimeError("TCP connection to device failed")  # no real SSH in tests

    monkeypatch.setattr(get_inventory, "open_session", fake_session)
    r = client.post("/api/tools/get_inventory/run",
                    json={"params": {"inventory_list": "lab", "site": "BR", "username": "u", "password": "p"}})
    job = wait_job(r.json()["job_id"])
    assert [(row["IP Address"], row["Site"], row["Status"]) for row in job["rows"]] == [("10.0.0.2", "BR", "Connection Error")]
