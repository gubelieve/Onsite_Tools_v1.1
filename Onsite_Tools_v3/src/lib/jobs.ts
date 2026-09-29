/**
 * Background job runner. A job is one run of a tool; the tool publishes a results table, progress,
 * messages and artifacts through JobContext and the browser polls GET /api/jobs/<id>.
 * Live jobs are kept in memory; finished jobs are saved to the local database (JobRun).
 */
import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import prisma from "./prisma"
import { hms, LOGS_DIR, ensureDir, makeRunDir } from "./paths"
import { TOOLS } from "./tools"
import type { Params, ToolDef } from "./tools/types"

export type JobStatus = "queued" | "running" | "done" | "stopped" | "error"
export type RowData = Record<string, unknown>

export interface JobSnapshot {
  id: string
  toolId: string
  toolName: string
  runLabel: string
  latestFirst: boolean
  groupBy: string
  status: JobStatus
  created: string
  finished: string | null
  version: number
  columns: string[]
  exportColumns: string[] | null
  rows: (RowData & { _key: string })[]
  progress: { done: number; total: number }
  messages: { seq: number; level: string; text: string; ts: string }[]
  logs: { ts: string; level: string; text: string }[]
  summary: string
  artifacts: { index: number; name: string; path: string }[]
  error: string | null
  runDir: string | null
}

export class StopRequested extends Error {}

const MAX_LOGS = 3000
const MAX_LIVE_JOBS = 40
const nowText = () => new Date().toLocaleString("sv-SE")

class Job {
  id = randomUUID().replace(/-/g, "").slice(0, 12)
  status: JobStatus = "queued"
  created = nowText()
  finished: string | null = null
  version = 0
  columns: string[] = []
  exportColumns: string[] | null = null
  rows = new Map<string, RowData>()
  rowSeq = 0
  progress = { done: 0, total: 0 }
  messages: JobSnapshot["messages"] = []
  logs: JobSnapshot["logs"] = []
  summary = ""
  artifacts: { name: string; path: string }[] = []
  error: string | null = null
  runDir: string | null = null
  stop = false

  constructor(public toolId: string, public toolName: string, public runLabel: string, public latestFirst = false, public groupBy = "") {}

  snapshot(): JobSnapshot {
    return {
      id: this.id, toolId: this.toolId, toolName: this.toolName, runLabel: this.runLabel, latestFirst: this.latestFirst, groupBy: this.groupBy, status: this.status,
      created: this.created, finished: this.finished, version: this.version, columns: [...this.columns],
      exportColumns: this.exportColumns,
      rows: [...this.rows].map(([k, r]) => ({ ...r, _key: k })),
      progress: { ...this.progress }, messages: [...this.messages], logs: this.logs.slice(-300), summary: this.summary,
      artifacts: this.artifacts.map((a, index) => ({ index, ...a })), error: this.error, runDir: this.runDir,
    }
  }
}

export class JobContext {
  constructor(private job: Job) {}

  get stopRequested() { return this.job.stop }
  checkStop() { if (this.job.stop) throw new StopRequested() }
  get runDir(): string { return (this.job.runDir ??= makeRunDir(this.job.toolId)) }
  /** Join an existing folder (a run session) instead of opening a new logs/<tool>/<stamp> one. */
  setRunDir(dir: string) { this.job.runDir = ensureDir(dir); this.job.version++ }

  setColumns(columns: string[], exportColumns?: string[]) {
    this.job.columns = [...columns]
    this.job.exportColumns = exportColumns ? [...exportColumns] : null
    this.job.version++
  }
  addRow(row: RowData, key?: string): string {
    const k = key ?? `r${++this.job.rowSeq}`
    this.job.rows.set(k, { ...row })
    this.job.version++
    return k
  }
  updateRow(key: string, patch: RowData) {
    this.job.rows.set(key, { ...(this.job.rows.get(key) ?? {}), ...patch })
    this.job.version++
  }
  rows(): RowData[] { return [...this.job.rows.values()] }

  progress(done?: number, total?: number) {
    if (total !== undefined) this.job.progress.total = total
    if (done !== undefined) this.job.progress.done = done
    this.job.version++
  }
  step(n = 1) { this.job.progress.done += n; this.job.version++ }
  summary(text: string) { this.job.summary = text; this.job.version++ }

  private message(text: string, level: string) {
    this.job.messages.push({ seq: this.job.messages.length + 1, level, text, ts: hms() })
    this.log(text, level.toUpperCase())
  }
  info(text: string) { this.message(text, "info") }
  warn(text: string) { this.message(text, "warning") }
  error(text: string) { this.message(text, "error") }

  log(text: string, level = "INFO") {
    this.job.logs.push({ ts: hms(), level, text })
    if (this.job.logs.length > MAX_LOGS) this.job.logs.splice(0, this.job.logs.length - MAX_LOGS)
    this.job.version++
    try {
      const dir = ensureDir(path.join(LOGS_DIR, this.job.toolId))
      const day = new Date().toLocaleDateString("sv-SE")
      const line = `${nowText()} - ${level} - ${text}\n`
      fs.appendFileSync(path.join(dir, `${this.job.toolId}_${day}.log`), line, "utf8")
      // The run folder keeps its own copy, so a zip of that folder is the whole story of the run.
      if (this.job.runDir) fs.appendFileSync(path.join(this.job.runDir, "job.log"), line, "utf8")
    } catch { /* logging must never break a run */ }
  }

  artifact(name: string, filePath: string) { this.job.artifacts.push({ name, path: filePath }); this.job.version++ }

  /** Run fn for every item with at most `limit` in flight. One failing item never kills the job. */
  async mapParallel<T>(items: T[], fn: (item: T) => Promise<void>, limit = 10, countProgress = true) {
    const queue = [...items]
    if (countProgress) this.progress(0, items.length)
    const worker = async () => {
      for (;;) {
        const item = queue.shift()
        if (item === undefined) return
        if (!this.job.stop) {
          try { await fn(item) } catch (e) {
            if (!(e instanceof StopRequested)) this.log(`Unhandled error: ${(e as Error)?.stack ?? e}`, "ERROR")
          }
        }
        if (countProgress) this.step()
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, 100, items.length || 1)) }, worker))
  }
}

class JobManager {
  private jobs = new Map<string, Job>()

  start(tool: ToolDef, params: Params, runLabel: string): string {
    const job = new Job(tool.id, tool.name, runLabel, tool.latestFirst ?? false, tool.groupBy ?? "")
    this.jobs.set(job.id, job)
    this.evict()
    void this.execute(tool, job, params)
    return job.id
  }

  private async execute(tool: ToolDef, job: Job, params: Params) {
    const ctx = new JobContext(job)
    job.status = "running"
    job.version++
    try {
      await tool.run(ctx, params)
      job.status = job.stop ? "stopped" : "done"
    } catch (e) {
      if (e instanceof StopRequested) job.status = "stopped"
      else {
        job.status = "error"
        job.error = String((e as Error)?.message ?? e)
        ctx.log(`Job failed: ${(e as Error)?.stack ?? e}`, "ERROR")
      }
    }
    job.finished = nowText()
    job.version++
    await this.persist(job)
  }

  private async persist(job: Job) {
    try {
      const snap = job.snapshot()
      await prisma.jobRun.create({
        data: {
          id: job.id, toolId: job.toolId, toolName: job.toolName, runLabel: job.runLabel, status: job.status,
          summary: job.summary, rowCount: job.rows.size, runDir: job.runDir ?? "", snapshot: JSON.stringify(snap),
          finishedAt: new Date(),
        },
      })
    } catch (e) {
      console.error("could not save job history", e)
    }
  }

  private evict() {
    const finished = [...this.jobs.values()].filter((j) => !["queued", "running"].includes(j.status))
    while (this.jobs.size > MAX_LIVE_JOBS && finished.length) this.jobs.delete(finished.shift()!.id)
  }

  /** Cheap "has anything happened?" for a running job - avoids rebuilding and shipping the whole snapshot. */
  versionOf(id: string): number | null {
    const live = this.jobs.get(id)
    return live ? live.version : null
  }

  async get(id: string): Promise<JobSnapshot | null> {
    const live = this.jobs.get(id)
    if (live) return live.snapshot()
    const saved = await prisma.jobRun.findUnique({ where: { id } })
    if (!saved) return null
    const snap = JSON.parse(saved.snapshot) as JobSnapshot
    // How a result is laid out is not part of what the run found: a run saved before the newest-first
    // ordering or the per-device grouping existed still gets today's presentation.
    const tool = TOOLS.find((t) => t.id === snap.toolId)
    return { ...snap, latestFirst: snap.latestFirst ?? tool?.latestFirst ?? false, groupBy: snap.groupBy ?? tool?.groupBy ?? "" }
  }

  stop(id: string): boolean {
    const job = this.jobs.get(id)
    if (!job) return false
    job.stop = true
    job.version++
    return true
  }

  running(toolId?: string) {
    return [...this.jobs.values()]
      .filter((j) => ["queued", "running"].includes(j.status) && (!toolId || j.toolId === toolId))
      .map((j) => ({ id: j.id, toolId: j.toolId, toolName: j.toolName, runLabel: j.runLabel, status: j.status,
        created: j.created, rowCount: j.rows.size, summary: j.summary }))
  }
}

// One manager per process - Next.js can load this module more than once (route bundles, dev reloads).
declare const globalThis: { onsiteJobs?: JobManager } & typeof global
export const jobs = (globalThis.onsiteJobs ??= new JobManager())
