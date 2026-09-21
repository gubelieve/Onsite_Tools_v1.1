/**
 * Run sessions. Some work is one job per step (the IOS upgrade runs one stage at a time), and the person doing it
 * wants every step of that upgrade in ONE folder with ONE results table. A session is exactly that: it opens on the
 * first run, every later run joins it, and it only ends when the user presses Done - then the next run starts a new one.
 *
 * The state lives in the session folder itself (session.json), so it survives a restart of the app.
 */
import fs from "node:fs"
import path from "node:path"
import { toCsv } from "./csv"
import { DATA_DIR, LOGS_DIR, ensureDir, stamp } from "./paths"

export type SessionRow = Record<string, unknown>

export interface ToolSession {
  toolId: string
  /** logs/<toolId>/session_<stamp> - every run of the session writes its logs here. */
  dir: string
  started: string
  /** One entry per run that joined the session, oldest first. */
  runs: { label: string; at: string; rows: number }[]
  columns: string[]
  /** Every row of every run so far, so the table shows all stages and not just the last one. */
  rows: SessionRow[]
}

const POINTER = () => path.join(DATA_DIR, "sessions.json")
const now = () => new Date().toLocaleString("sv-SE")

function pointers(): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(POINTER(), "utf8")) as Record<string, string> } catch { return {} }
}

function setPointer(toolId: string, dir: string | null) {
  const all = pointers()
  if (dir) all[toolId] = dir
  else delete all[toolId]
  ensureDir(DATA_DIR)
  fs.writeFileSync(POINTER(), JSON.stringify(all, null, 2), "utf8")
}

function read(dir: string): ToolSession | null {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8")) as ToolSession
    return s && Array.isArray(s.rows) ? { ...s, dir } : null
  } catch { return null }
}

/** The session that later runs join, or null when the last one was closed with Done. */
export function activeSession(toolId: string): ToolSession | null {
  const dir = pointers()[toolId]
  if (!dir || !fs.existsSync(dir)) return null
  return read(dir)
}

/** The session to write into: the open one, or a brand new folder. */
export function openSession(toolId: string): ToolSession {
  const existing = activeSession(toolId)
  if (existing) return existing
  // Done followed immediately by a new run lands in the same second - never reuse (and overwrite) that folder.
  const base = path.join(LOGS_DIR, toolId, `session_${stamp()}`)
  let dir = base
  for (let n = 2; fs.existsSync(dir); n++) dir = `${base}_${n}`
  ensureDir(dir)
  const session: ToolSession = { toolId, dir, started: now(), runs: [], columns: [], rows: [] }
  saveSession(session)
  setPointer(toolId, dir)
  return session
}

/** session.json is the state; session_results.csv is there so the folder is useful on its own (and in the zip). */
export function saveSession(session: ToolSession) {
  ensureDir(session.dir)
  fs.writeFileSync(path.join(session.dir, "session.json"), JSON.stringify(session, null, 2), "utf8")
  if (session.columns.length) {
    fs.writeFileSync(path.join(session.dir, "session_results.csv"), toCsv(session.columns, session.rows), "utf8")
  }
}

/** Record what one run added. Returns the updated session. */
export function appendRun(session: ToolSession, label: string, columns: string[], rows: SessionRow[]): ToolSession {
  session.runs.push({ label, at: now(), rows: rows.length })
  session.columns = columns.length ? columns : session.columns
  session.rows = [...session.rows, ...rows]
  saveSession(session)
  return session
}

/** Done: the folder stays, the next run starts a new one. */
export function endSession(toolId: string): ToolSession | null {
  const session = activeSession(toolId)
  setPointer(toolId, null)
  if (session) {
    session.runs.push({ label: "Done", at: now(), rows: 0 })
    saveSession(session)
  }
  return session
}

/** What the browser shows above the form. */
export function sessionInfo(toolId: string) {
  const s = activeSession(toolId)
  return s
    ? { active: true, dir: s.dir, name: path.basename(s.dir), started: s.started, rowCount: s.rows.length,
        runs: s.runs.filter((r) => r.label !== "Done").map((r) => r.label) }
    : { active: false, dir: "", name: "", started: "", rowCount: 0, runs: [] as string[] }
}
