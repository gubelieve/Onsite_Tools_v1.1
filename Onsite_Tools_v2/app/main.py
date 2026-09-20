"""FastAPI application: static UI + JSON API used by static/app.js."""
import io
import os
import re
import socket
import threading
from datetime import datetime
from typing import List, Optional

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .core import csvutil
from .core.jobs import manager
from .core.netutil import DEVICE_TYPES
from .core.paths import (BASE_DIR, EXPORTS_DIR, STATIC_DIR, TEMPLATES_DIR, UPLOADS_DIR, ensure_dirs,
                         public_settings)
from .tools import all_tools, get_tool, load_errors, public

ensure_dirs()

app = FastAPI(title="Onsite Tools", version=__version__)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


# --------------------------------------------------------------------------- UI
@app.get("/", response_class=HTMLResponse)
def index():
    with open(os.path.join(STATIC_DIR, "index.html"), "r", encoding="utf-8") as f:
        return f.read()


@app.get("/api/meta")
def meta():
    return {
        "version": __version__,
        "settings": public_settings(),
        "device_types": DEVICE_TYPES,
        "load_errors": load_errors(),
        "hostname": socket.gethostname(),
    }


@app.get("/api/tools")
def tools():
    return [public(t) for t in all_tools()]


# ------------------------------------------------------------------------ files
def _safe_filename(name: str) -> str:
    name = os.path.basename(name or "upload")
    return re.sub(r"[^A-Za-z0-9._-]+", "_", name) or "upload"


@app.post("/api/upload")
async def upload(files: List[UploadFile] = File(...)):
    out = []
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    for i, uf in enumerate(files):
        data = await uf.read()
        fname = f"{stamp}_{i}_{_safe_filename(uf.filename)}"
        path = os.path.join(UPLOADS_DIR, fname)
        with open(path, "wb") as f:
            f.write(data)
        out.append({"name": uf.filename, "path": path, "size": len(data)})
    return out


@app.get("/api/csv/info")
def csv_info(path: str):
    try:
        fields, rows = csvutil.read_csv(path)
    except Exception as e:
        raise HTTPException(400, str(e))
    return {"columns": fields, "row_count": len(rows), "preview": rows[:5]}


@app.get("/api/csv/values")
def csv_values(path: str, column: str = "Site"):
    try:
        return csvutil.unique_values(path, column)
    except Exception as e:
        raise HTTPException(400, str(e))


@app.get("/api/templates")
def templates():
    items = []
    if os.path.isdir(TEMPLATES_DIR):
        for n in sorted(os.listdir(TEMPLATES_DIR)):
            p = os.path.join(TEMPLATES_DIR, n)
            if os.path.isfile(p):
                items.append({"name": n, "size": os.path.getsize(p)})
    return items


@app.get("/api/templates/{name}")
def template(name: str):
    name = os.path.basename(name)
    p = os.path.join(TEMPLATES_DIR, name)
    if not os.path.isfile(p):
        raise HTTPException(404, "template not found")
    return FileResponse(p, filename=name, media_type="text/csv")


@app.get("/api/local-ip")
def local_ip():
    return {"ip": _detect_local_ip()}


def _detect_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        try:
            return socket.gethostbyname(socket.gethostname())
        except Exception:
            return "192.168.1.100"


# Native file/folder picker (works when the browser runs on the same machine as the server)
_browse_lock = threading.Lock()


@app.post("/api/browse")
async def browse(request: Request):
    body = await request.json()
    kind = body.get("kind", "file")
    title = body.get("title") or "Select"
    filetypes = body.get("filetypes") or [["All files", "*.*"]]
    initial = body.get("initial") or BASE_DIR
    result = {"path": None}

    def worker():
        try:
            import tkinter as tk
            from tkinter import filedialog

            root = tk.Tk()
            root.withdraw()
            root.attributes("-topmost", True)
            ft = [tuple(x) for x in filetypes]
            if kind == "folder":
                p = filedialog.askdirectory(title=title, initialdir=initial)
            elif kind == "save":
                p = filedialog.asksaveasfilename(title=title, initialdir=initial, filetypes=ft,
                                                 initialfile=body.get("initialfile") or "")
            elif kind == "files":
                p = filedialog.askopenfilenames(title=title, initialdir=initial, filetypes=ft)
                p = list(p) if p else None
            else:
                p = filedialog.askopenfilename(title=title, initialdir=initial, filetypes=ft)
            root.destroy()
            result["path"] = p or None
        except Exception as e:
            result["error"] = str(e)

    if not _browse_lock.acquire(blocking=False):
        raise HTTPException(409, "A file dialog is already open on the server machine")
    try:
        t = threading.Thread(target=worker, daemon=True)
        t.start()
        t.join(timeout=600)
    finally:
        _browse_lock.release()
    if result.get("error"):
        raise HTTPException(500, f"Native dialog unavailable: {result['error']}")
    return result


# ------------------------------------------------------------------------- jobs
@app.post("/api/tools/{tool_id}/run")
async def run_tool(tool_id: str, request: Request):
    tool = get_tool(tool_id)
    if not tool:
        raise HTTPException(404, "unknown tool")
    body = await request.json()
    params = body.get("params") or {}
    run_id = body.get("run_id") or "run"
    run_def = next((r for r in tool["runs"] if r.get("id") == run_id), tool["runs"][0])
    params = dict(params, **(run_def.get("params") or {}))
    # required-field validation
    missing = []
    for f in tool["fields"]:
        if f.get("required") and not _visible(f, params):
            continue
        if f.get("required") and params.get(f["name"]) in (None, "", [], {}):
            missing.append(f.get("label") or f["name"])
    if missing:
        raise HTTPException(400, "Please fill in: " + ", ".join(missing))
    job = manager.start(tool, params, run_def.get("label", "Run"))
    return {"job_id": job.id}


def _visible(field, params):
    cond = field.get("show_if")
    if not cond:
        return True
    return all(str(params.get(k, "")) == str(v) for k, v in cond.items())


@app.post("/api/tools/{tool_id}/action/{action}")
async def tool_action(tool_id: str, action: str, request: Request):
    tool = get_tool(tool_id)
    if not tool:
        raise HTTPException(404, "unknown tool")
    fn = tool["actions"].get(action)
    if not fn:
        raise HTTPException(404, "unknown action")
    try:
        body = await request.json()
    except Exception:
        body = {}
    try:
        return fn(body or {})
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, str(e))


@app.post("/api/tools/{tool_id}/job-action/{action}")
async def tool_job_action(tool_id: str, action: str, request: Request):
    tool = get_tool(tool_id)
    if not tool:
        raise HTTPException(404, "unknown tool")
    fn = tool["job_actions"].get(action)
    if not fn:
        raise HTTPException(404, "unknown job action")
    body = await request.json()
    job = manager.get(body.get("job_id", ""))
    if not job:
        raise HTTPException(404, "job not found")
    try:
        return fn(job, body.get("params") or {})
    except Exception as e:
        raise HTTPException(400, str(e))


@app.get("/api/jobs")
def jobs(tool: Optional[str] = None):
    return manager.list(tool)


@app.get("/api/jobs/{job_id}")
def job(job_id: str):
    j = manager.get(job_id)
    if not j:
        raise HTTPException(404, "job not found")
    return j.snapshot()


@app.post("/api/jobs/{job_id}/stop")
def stop_job(job_id: str):
    if not manager.stop(job_id):
        raise HTTPException(404, "job not found")
    return {"ok": True}


@app.get("/api/jobs/{job_id}/export.csv")
def export_job(job_id: str):
    j = manager.get(job_id)
    if not j:
        raise HTTPException(404, "job not found")
    snap = j.snapshot()
    cols = j.export_columns or snap["columns"]
    buf = io.StringIO()
    import csv

    w = csv.DictWriter(buf, fieldnames=cols, extrasaction="ignore")
    w.writeheader()
    for r in snap["rows"]:
        w.writerow({c: csvutil._cell(r.get(c, "")) for c in cols})
    data = ("﻿" + buf.getvalue()).encode("utf-8")
    fname = f"{j.tool_id}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
    # also keep a copy in exports/
    try:
        with open(os.path.join(EXPORTS_DIR, fname), "wb") as f:
            f.write(data)
    except Exception:
        pass
    return StreamingResponse(io.BytesIO(data), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="{fname}"'})


@app.get("/api/jobs/{job_id}/artifact/{index}")
def job_artifact(job_id: str, index: int):
    j = manager.get(job_id)
    if not j:
        raise HTTPException(404, "job not found")
    try:
        a = j.artifacts[index]
    except IndexError:
        raise HTTPException(404, "artifact not found")
    if not os.path.isfile(a["path"]):
        raise HTTPException(404, "artifact file missing")
    return FileResponse(a["path"], filename=a["name"])


@app.get("/api/file")
def get_file(path: str):
    """Serve a file that lives inside the project folder (reports, screenshots)."""
    real = os.path.abspath(path)
    if not real.startswith(os.path.abspath(BASE_DIR)) or not os.path.isfile(real):
        raise HTTPException(404, "file not found")
    return FileResponse(real, filename=os.path.basename(real))


@app.exception_handler(Exception)
async def _unhandled(request: Request, exc: Exception):
    return JSONResponse(status_code=500, content={"detail": str(exc)})
