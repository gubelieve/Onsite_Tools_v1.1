"""Background job runner.

A *job* is one run of a tool. The tool receives a :class:`JobContext` and uses it to
publish a results table (columns/rows), progress, messages and downloadable
artifacts. The browser polls ``GET /api/jobs/<id>`` and renders the snapshot.
"""
import threading
import traceback
import uuid
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor, wait
from datetime import datetime

from .logutil import make_run_dir, tool_logger

MAX_JOBS_KEPT = 60
MAX_LOG_LINES = 3000


class StopRequested(Exception):
    """Raised inside a tool when the user pressed Stop."""


class Job:
    def __init__(self, tool_id, tool_name, params, run_label):
        self.id = uuid.uuid4().hex[:12]
        self.tool_id = tool_id
        self.tool_name = tool_name
        self.params = params
        self.run_label = run_label
        self.status = "queued"  # queued | running | done | stopped | error
        self.created = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        self.started = None
        self.finished = None
        self.lock = threading.RLock()
        self.columns = []
        self.export_columns = None
        self.rows = OrderedDict()
        self._row_seq = 0
        self.progress = {"done": 0, "total": 0}
        self.messages = []
        self._msg_seq = 0
        self.logs = []
        self.summary = ""
        self.artifacts = []
        self.error = None
        self.stop_event = threading.Event()
        self.run_dir = None
        self.version = 0

    def _bump(self):
        self.version += 1

    def snapshot(self):
        with self.lock:
            return {
                "id": self.id,
                "tool_id": self.tool_id,
                "tool_name": self.tool_name,
                "run_label": self.run_label,
                "status": self.status,
                "created": self.created,
                "started": self.started,
                "finished": self.finished,
                "version": self.version,
                "columns": list(self.columns),
                "rows": [dict(r, _key=k) for k, r in self.rows.items()],
                "progress": dict(self.progress),
                "messages": list(self.messages),
                "logs": self.logs[-300:],
                "summary": self.summary,
                "artifacts": [{"index": i, "name": a["name"], "path": a["path"]} for i, a in enumerate(self.artifacts)],
                "error": self.error,
                "run_dir": self.run_dir,
            }

    def brief(self):
        with self.lock:
            return {
                "id": self.id,
                "tool_id": self.tool_id,
                "tool_name": self.tool_name,
                "run_label": self.run_label,
                "status": self.status,
                "created": self.created,
                "finished": self.finished,
                "progress": dict(self.progress),
                "rows": len(self.rows),
                "summary": self.summary,
            }


class JobContext:
    """API handed to tool ``run(ctx, params)`` functions."""

    def __init__(self, job: Job):
        self.job = job
        self.params = job.params
        self.tool_id = job.tool_id
        self.file_log = tool_logger(job.tool_id)

    # ---- control -------------------------------------------------------
    @property
    def stop_requested(self):
        return self.job.stop_event.is_set()

    def check_stop(self):
        if self.stop_requested:
            raise StopRequested()

    @property
    def run_dir(self):
        if not self.job.run_dir:
            self.job.run_dir = make_run_dir(self.job.tool_id)
        return self.job.run_dir

    # ---- table ---------------------------------------------------------
    def set_columns(self, columns, export_columns=None):
        with self.job.lock:
            self.job.columns = list(columns)
            self.job.export_columns = list(export_columns) if export_columns else None
            self.job._bump()

    def add_column(self, column):
        with self.job.lock:
            if column not in self.job.columns:
                self.job.columns.append(column)
                self.job._bump()

    def add_row(self, row, key=None):
        with self.job.lock:
            if key is None:
                self.job._row_seq += 1
                key = f"r{self.job._row_seq}"
            self.job.rows[key] = dict(row)
            self.job._bump()
            return key

    def update_row(self, key, **patch):
        with self.job.lock:
            row = self.job.rows.get(key)
            if row is None:
                row = {}
                self.job.rows[key] = row
            row.update({k: v for k, v in patch.items()})
            self.job._bump()

    def get_row(self, key):
        with self.job.lock:
            return dict(self.job.rows.get(key, {}))

    def rows(self):
        with self.job.lock:
            return [dict(r, _key=k) for k, r in self.job.rows.items()]

    # ---- progress / messages ------------------------------------------
    def progress(self, done=None, total=None):
        with self.job.lock:
            if total is not None:
                self.job.progress["total"] = int(total)
            if done is not None:
                self.job.progress["done"] = int(done)
            self.job._bump()

    def step(self, n=1):
        with self.job.lock:
            self.job.progress["done"] += n
            self.job._bump()

    def summary(self, text):
        with self.job.lock:
            self.job.summary = str(text)
            self.job._bump()

    def message(self, text, level="info"):
        with self.job.lock:
            self.job._msg_seq += 1
            self.job.messages.append({"seq": self.job._msg_seq, "level": level, "text": str(text),
                                      "ts": datetime.now().strftime("%H:%M:%S")})
            self.job._bump()
        self.log(text, level.upper())

    def info(self, text):
        self.message(text, "info")

    def warn(self, text):
        self.message(text, "warning")

    def error(self, text):
        self.message(text, "error")

    def log(self, text, level="INFO"):
        with self.job.lock:
            self.job.logs.append({"ts": datetime.now().strftime("%H:%M:%S"), "level": level, "text": str(text)})
            if len(self.job.logs) > MAX_LOG_LINES:
                del self.job.logs[: len(self.job.logs) - MAX_LOG_LINES]
            self.job._bump()
        try:
            lvl = level.upper()
            if lvl in ("ERROR", "CRITICAL"):
                self.file_log.error(text)
            elif lvl == "WARNING":
                self.file_log.warning(text)
            else:
                self.file_log.info(text)
        except Exception:
            pass

    def artifact(self, name, path):
        with self.job.lock:
            self.job.artifacts.append({"name": name, "path": path})
            self.job._bump()

    # ---- parallel helper -----------------------------------------------
    def map_parallel(self, items, fn, max_workers=10, count_progress=True):
        """Run ``fn(item)`` for each item on a thread pool.

        Progress is advanced per finished item. Items not yet started when Stop is
        pressed are skipped. Exceptions inside ``fn`` are logged, not raised.
        """
        items = list(items)
        max_workers = max(1, min(int(max_workers or 1), 100))
        if count_progress:
            self.progress(0, len(items))

        def runner(item):
            if self.stop_requested:
                return None
            try:
                return fn(item)
            except StopRequested:
                return None
            except Exception as e:  # never let one device kill the job
                self.log(f"Unhandled error for {item!r}: {e}\n{traceback.format_exc()}", "ERROR")
                return None
            finally:
                if count_progress:
                    self.step()

        results = []
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            futures = [pool.submit(runner, it) for it in items]
            wait(futures)
            for f in futures:
                try:
                    results.append(f.result())
                except Exception:
                    results.append(None)
        return results


class JobManager:
    def __init__(self):
        self.jobs = OrderedDict()
        self.lock = threading.Lock()

    def start(self, tool, params, run_label="Run"):
        job = Job(tool["id"], tool["name"], params, run_label)
        with self.lock:
            self.jobs[job.id] = job
            self._evict()
        t = threading.Thread(target=self._run, args=(tool, job), daemon=True, name=f"job-{job.id}")
        t.start()
        return job

    def _run(self, tool, job):
        ctx = JobContext(job)
        with job.lock:
            job.status = "running"
            job.started = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            job._bump()
        try:
            tool["run"](ctx, job.params)
            with job.lock:
                job.status = "stopped" if job.stop_event.is_set() else "done"
        except StopRequested:
            with job.lock:
                job.status = "stopped"
        except Exception as e:
            ctx.log(f"Job failed: {e}\n{traceback.format_exc()}", "ERROR")
            with job.lock:
                job.status = "error"
                job.error = str(e)
        finally:
            with job.lock:
                job.finished = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                job._bump()

    def _evict(self):
        finished = [k for k, j in self.jobs.items() if j.status in ("done", "stopped", "error")]
        while len(self.jobs) > MAX_JOBS_KEPT and finished:
            self.jobs.pop(finished.pop(0), None)

    def get(self, job_id):
        return self.jobs.get(job_id)

    def list(self, tool_id=None):
        with self.lock:
            jobs = list(self.jobs.values())
        if tool_id:
            jobs = [j for j in jobs if j.tool_id == tool_id]
        return [j.brief() for j in reversed(jobs)]

    def stop(self, job_id):
        job = self.jobs.get(job_id)
        if not job:
            return False
        job.stop_event.set()
        with job.lock:
            job._bump()
        return True


manager = JobManager()
