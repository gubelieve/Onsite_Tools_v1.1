import time

import pytest

from app.core import csvutil
from app.core.jobs import JobManager


def write(path, text, bom=False):
    # Path.write_text(newline=...) needs Python 3.10+, and we must keep "\r\n" exactly as given
    with open(path, "w", encoding="utf-8-sig" if bom else "utf-8", newline="") as f:
        f.write(text)
    return str(path)


def test_load_devices_standard_csv_with_bom_and_site_filter(tmp_path):
    p = write(tmp_path / "d.csv", "Site,IP_Address,Device_Type,Description\r\nA,10.0.0.1,cisco_ios,core\r\n"
                                  "B,10.0.0.2,autodetect,edge\r\nA,,cisco_ios,blank ip\r\n", bom=True)
    assert csvutil.unique_values(p, "Site") == ["A", "B"]
    assert [d["host"] for d in csvutil.load_devices(p)] == ["10.0.0.1", "10.0.0.2"]  # blank IP skipped
    only_a = csvutil.load_devices(p, "A")
    assert len(only_a) == 1 and only_a[0]["device_type"] == "cisco_ios" and only_a[0]["site"] == "A"


def test_load_devices_upgrade_list_aliases(tmp_path):
    p = write(tmp_path / "u.csv",
              "ip_mgmt,hostname,zone,model,brand,device_type\n10.0.251.62,SS-SW,Site1,C9300,IOS-XE,cisco_ios\n")
    assert csvutil.unique_values(p, "zone") == ["Site1"]
    d = csvutil.load_devices(p, "All Sites")[0]
    assert (d["host"], d["hostname"], d["site"]) == ("10.0.251.62", "SS-SW", "Site1")


def test_multiline_command_cell_and_trailing_empty_columns(tmp_path):
    p = write(tmp_path / "c.csv", 'Site,IP_Address,command,,,\nA,10.0.0.1,"show clock\nshow ver",,,\n')
    fields, rows = csvutil.read_csv(p)
    assert csvutil.find_col(fields, "command") == "command"
    assert rows[0]["command"].splitlines() == ["show clock", "show ver"]


def test_missing_ip_column_is_reported(tmp_path):
    p = write(tmp_path / "bad.csv", "Site,Name\nA,x\n")
    with pytest.raises(ValueError):
        csvutil.load_devices(p)


def test_write_csv_roundtrip(tmp_path):
    out = tmp_path / "o.csv"
    csvutil.write_csv(str(out), ["a", "b"], [{"a": "1", "b": ["x", "y"], "ignored": 1}])
    fields, rows = csvutil.read_csv(str(out))
    assert fields == ["a", "b"] and rows == [{"a": "1", "b": "x; y"}]


def wait_done(job, timeout=15):
    end = time.time() + timeout
    while job.status in ("queued", "running") and time.time() < end:
        time.sleep(0.02)
    return job.snapshot()


def fake_tool(run):
    return {"id": "pytest_tool", "name": "Pytest tool", "run": run}


def test_job_collects_rows_progress_and_messages():
    def run(ctx, params):
        ctx.set_columns(["Host", "Status"])
        keys = {h: ctx.add_row({"Host": h, "Status": "Pending"}) for h in params["hosts"]}

        def work(h):
            if h == "bad":
                raise RuntimeError("boom")
            ctx.update_row(keys[h], Status="Success")

        ctx.map_parallel(params["hosts"], work, 4)
        ctx.summary("finished")
        ctx.info("all done")

    snap = wait_done(JobManager().start(fake_tool(run), {"hosts": ["a", "b", "bad"]}))
    assert snap["status"] == "done"  # one failing device must not kill the job
    assert snap["progress"] == {"done": 3, "total": 3}
    assert {r["Host"]: r["Status"] for r in snap["rows"]} == {"a": "Success", "b": "Success", "bad": "Pending"}
    assert snap["summary"] == "finished" and snap["messages"][0]["text"] == "all done"
    assert any("boom" in entry["text"] for entry in snap["logs"])


def test_job_error_and_stop():
    mgr = JobManager()

    def crash(ctx, params):
        raise ValueError("bad input")

    snap = wait_done(mgr.start(fake_tool(crash), {}))
    assert snap["status"] == "error" and snap["error"] == "bad input"

    def slow(ctx, params):
        ctx.map_parallel(range(50), lambda i: time.sleep(0.05), 1)

    job = mgr.start(fake_tool(slow), {})
    time.sleep(0.15)
    assert mgr.stop(job.id)
    assert wait_done(job)["status"] == "stopped"
    assert mgr.stop("does-not-exist") is False
