import time

import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def wait_job(job_id, timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        job = client.get(f"/api/jobs/{job_id}").json()
        if job["status"] not in ("queued", "running"):
            return job
        time.sleep(0.05)
    pytest.fail("job did not finish")


def test_index_meta_and_tools():
    assert "Onsite Tools" in client.get("/").text
    meta = client.get("/api/meta").json()
    assert meta["load_errors"] == {} and "autodetect" in meta["device_types"]
    tools = client.get("/api/tools").json()
    assert len(tools) == 14 and all("run" not in t for t in tools)


def test_templates_are_downloadable():
    names = [t["name"] for t in client.get("/api/templates").json()]
    assert "device_list_template.csv" in names and "shc_template.csv" in names
    r = client.get("/api/templates/device_list_template.csv")
    assert r.status_code == 200 and r.text.startswith("Site,IP_Address")
    assert client.get("/api/templates/no_such_template.csv").status_code == 404


def test_upload_then_csv_info_and_sites():
    r = client.post("/api/upload",
                    files={"files": ("my list.csv", b"Site,IP_Address\nHQ,10.0.0.1\nBR,10.0.0.2\n", "text/csv")})
    path = r.json()[0]["path"]
    info = client.get("/api/csv/info", params={"path": path}).json()
    assert info["columns"] == ["Site", "IP_Address"] and info["row_count"] == 2
    assert client.get("/api/csv/values", params={"path": path, "column": "Site"}).json() == ["BR", "HQ"]


def test_run_validates_required_fields_and_unknown_ids():
    r = client.post("/api/tools/get_inventory/run", json={"params": {"username": "u"}})
    assert r.status_code == 400 and "Password" in r.json()["detail"]
    assert client.post("/api/tools/nope/run", json={"params": {}}).status_code == 404
    assert client.get("/api/jobs/nope").status_code == 404


def test_file_endpoint_is_confined_to_project_folder(tmp_path):
    outside = tmp_path / "secret.txt"
    outside.write_text("x", encoding="utf-8")
    assert client.get("/api/file", params={"path": str(outside)}).status_code == 404


def test_tool_action_endpoint():
    r = client.post("/api/tools/upgrade_ios/action/local_ip", json={})
    assert r.status_code == 200 and r.json()["value"].count(".") == 3
    assert client.post("/api/tools/upgrade_ios/action/nope", json={}).status_code == 404


def test_interface_report_job_end_to_end(tmp_path):
    (tmp_path / "SW1-10.0.0.1_2025-01-01_010101.log").write_text(
        "vlan 10\n name USERS\n!\ninterface GigabitEthernet1/0/1\n switchport access vlan 10\n"
        " switchport mode access\n!\n", encoding="utf-8")
    r = client.post("/api/tools/interface_report/run",
                    json={"params": {"log_folder": str(tmp_path), "output_name": "t.csv"}})
    job = wait_job(r.json()["job_id"])
    assert job["status"] == "done" and job["progress"] == {"done": 1, "total": 1}
    assert job["rows"][0]["interface"] == "GigabitEthernet1/0/1" and job["rows"][0]["ip pool data"] == "USERS"
    assert len(job["artifacts"]) == 1
    csv_text = client.get(f"/api/jobs/{job['id']}/export.csv").text
    assert "GigabitEthernet1/0/1" in csv_text and "USERS" in csv_text
    assert client.get(f"/api/jobs/{job['id']}/artifact/0").status_code == 200
    jobs = client.get("/api/jobs", params={"tool": "interface_report"}).json()
    assert any(j["id"] == job["id"] for j in jobs)
