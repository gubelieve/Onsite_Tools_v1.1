import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"

// paths.ts reads the base folder once, at import time.
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "onsite-session-"))
process.env.ONSITE_BASE_DIR = BASE
const { activeSession, appendRun, endSession, openSession, sessionInfo } = await import("@/lib/session")

const COLUMNS = ["Stage", "Host", "Status"]
const row = (stage: number, status: string) => ({ Stage: `Stage ${stage}`, Host: "10.0.0.1", Status: status })

describe("run sessions", () => {
  it("keeps every stage in one folder until Done", () => {
    const first = openSession("upgrade-ios")
    expect(path.basename(first.dir)).toMatch(/^session_\d{4}-\d{2}-\d{2}_\d{6}/)
    appendRun(first, "Stage 0", COLUMNS, [row(0, "Pass"), row(0, "Completed")])

    // A later stage joins the same folder and sees the rows of the stage before it.
    const second = openSession("upgrade-ios")
    expect(second.dir).toBe(first.dir)
    expect(second.rows).toHaveLength(2)
    appendRun(second, "Stage 1", COLUMNS, [row(1, "Completed")])

    const info = sessionInfo("upgrade-ios")
    expect(info).toMatchObject({ active: true, dir: first.dir, rowCount: 3, runs: ["Stage 0", "Stage 1"] })

    // The folder is useful on its own: state plus a results file covering all stages.
    const csv = fs.readFileSync(path.join(first.dir, "session_results.csv"), "utf8")
    expect(csv).toContain("Stage 0")
    expect(csv).toContain("Stage 1")
    expect(JSON.parse(fs.readFileSync(path.join(first.dir, "session.json"), "utf8")).rows).toHaveLength(3)

    // Done closes it; the next run starts a new, empty folder and leaves the old one alone.
    endSession("upgrade-ios")
    expect(activeSession("upgrade-ios")).toBeNull()
    expect(sessionInfo("upgrade-ios").active).toBe(false)

    const third = openSession("upgrade-ios")
    expect(third.dir).not.toBe(first.dir)
    expect(third.rows).toHaveLength(0)
    expect(JSON.parse(fs.readFileSync(path.join(first.dir, "session.json"), "utf8")).rows).toHaveLength(3)
  })

  it("sessions of different tools do not share a folder", () => {
    const a = openSession("tool-a")
    const b = openSession("tool-b")
    expect(a.dir).not.toBe(b.dir)
    endSession("tool-a")
    expect(activeSession("tool-a")).toBeNull()
    expect(activeSession("tool-b")?.dir).toBe(b.dir)
  })

  it("a deleted session folder does not block the next run", () => {
    const s = openSession("tool-c")
    fs.rmSync(s.dir, { recursive: true, force: true })
    expect(activeSession("tool-c")).toBeNull()
    const next = openSession("tool-c")
    expect(fs.existsSync(path.join(next.dir, "session.json"))).toBe(true)
    expect(next.rows).toHaveLength(0)
  })
})
