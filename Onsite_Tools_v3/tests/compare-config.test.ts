import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { looksLikeDiff, parseUnified } from "@/lib/diff-format"
import { compareConfig, compileIgnore, DEFAULT_IGNORE, diffLines, normalize, scanFolder, unifiedDiff } from "@/lib/tools/compare-config"

const lines = (s: string) => s.trim().split("\n")

describe("diff engine", () => {
  it("keeps what stayed and marks what went and what came", () => {
    const ops = diffLines(["a", "b", "c"], ["a", "x", "c"])
    expect(ops.map((o) => o.type + o.line)).toEqual(["=a", "-b", "+x", "=c"])
  })

  it("handles insertions, deletions and empty sides", () => {
    expect(diffLines(["a", "c"], ["a", "b", "c"]).map((o) => o.type + o.line)).toEqual(["=a", "+b", "=c"])
    expect(diffLines(["a", "b", "c"], ["a", "c"]).map((o) => o.type + o.line)).toEqual(["=a", "-b", "=c"])
    expect(diffLines([], ["a"]).map((o) => o.type + o.line)).toEqual(["+a"])
    expect(diffLines(["a"], []).map((o) => o.type + o.line)).toEqual(["-a"])
    expect(diffLines([], [])).toEqual([])
  })

  it("finds the minimal change in a long file quickly", () => {
    const before = Array.from({ length: 5000 }, (_, i) => `line ${i}`)
    const after = [...before]
    after[2500] = "line 2500 CHANGED"
    const started = Date.now()
    const { added, removed, text } = unifiedDiff(before, after)
    expect({ added, removed }).toEqual({ added: 1, removed: 1 })
    expect(text).toContain("-line 2500")
    expect(text).toContain("+line 2500 CHANGED")
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it("writes a unified diff with line numbers and context", () => {
    const before = lines(`
hostname SW1
!
interface Gi1/0/1
 description USER
 switchport access vlan 10
!
logging host 10.1.1.1`)
    const after = lines(`
hostname SW1
!
interface Gi1/0/1
 description PRINTER
 switchport access vlan 20
!
logging host 10.1.1.1`)
    const { text, added, removed } = unifiedDiff(before, after, 1)
    expect({ added, removed }).toEqual({ added: 2, removed: 2 })
    expect(text.split("\n")).toEqual([
      "@@ -3,4 +3,4 @@",
      " interface Gi1/0/1",
      "- description USER",
      "- switchport access vlan 10",
      "+ description PRINTER",
      "+ switchport access vlan 20",
      " !",
    ])
    expect(unifiedDiff(before, before).text).toBe("")
  })
})

describe("what counts as a difference", () => {
  it("drops the lines that change by themselves", () => {
    const ignore = compileIgnore(DEFAULT_IGNORE.join("\n"))
    const text = "Building configuration...\n\nCurrent configuration : 4231 bytes\n! Last configuration change at 10:15:01 by admin\nhostname SW1\nntp clock-period 17179860\n"
    expect(normalize(text, ignore)).toEqual(["hostname SW1"])
    // Without the ignore list the noise is a difference like any other.
    expect(normalize(text, [])).toHaveLength(5)
  })

  it("ignores trailing whitespace, and a broken pattern does not stop the run", () => {
    expect(normalize("a  \nb\t\n", [])).toEqual(["a", "b"])
    expect(compileIgnore("valid\n[unclosed\n")).toHaveLength(1)
  })
})

describe("Compare Configuration - end to end on real log folders", () => {
  type Row = Record<string, unknown>
  const fakeCtx = (runDir: string) => {
    const rows: Row[] = []
    const messages: string[] = []
    return {
      rows, messages,
      ctx: {
        addRow: (r: Row) => { rows.push(r); return String(rows.length) },
        updateRow: () => undefined,
        setColumns: () => undefined,
        progress: () => undefined,
        step: () => undefined,
        checkStop: () => undefined,
        summary: (t: string) => messages.push(`summary: ${t}`),
        info: (t: string) => messages.push(`info: ${t}`),
        warn: (t: string) => messages.push(`warn: ${t}`),
        error: (t: string) => messages.push(`error: ${t}`),
        artifact: (name: string) => messages.push(`artifact: ${name}`),
        log: () => undefined,
        runDir,
        stopRequested: false,
      },
    }
  }

  const base = fs.mkdtempSync(path.join(os.tmpdir(), "onsite-compare-"))
  const write = (dir: string, name: string, body: string) => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, name), body, "utf8")
  }
  const beforeDir = path.join(base, "before"), afterDir = path.join(base, "after"), runDir = path.join(base, "run")
  fs.mkdirSync(runDir, { recursive: true })

  // Same layout Config Devices writes: <hostname>-<ip>_<stamp>.log
  write(beforeDir, "SW-CORE-10.0.0.1_2026-09-20_100000.log", "Building configuration...\n\nhostname SW-CORE\nlogging host 10.1.1.1\nntp clock-period 1\n")
  write(afterDir, "SW-CORE-10.0.0.1_2026-09-21_100000.log", "Building configuration...\n\nhostname SW-CORE\nlogging host 10.9.9.9\nntp clock-period 2\n")
  write(beforeDir, "SW-EDGE-10.0.0.2_2026-09-20_100000.log", "hostname SW-EDGE\nvlan 10\n")
  write(afterDir, "SW-EDGE-10.0.0.2_2026-09-21_100000.log", "hostname SW-EDGE\nvlan 10\n")
  write(beforeDir, "SW-GONE-10.0.0.3_2026-09-20_100000.log", "hostname SW-GONE\n")
  write(afterDir, "SW-NEW-10.0.0.4_2026-09-21_100000.log", "hostname SW-NEW\n")
  write(afterDir, "job.log", "2026-09-21 - INFO - the run's own log, not a device")

  it("matches devices by IP and ignores the run's own log", () => {
    expect([...scanFolder(beforeDir).keys()].sort()).toEqual(["10.0.0.1", "10.0.0.2", "10.0.0.3"])
    expect([...scanFolder(afterDir).keys()].sort()).toEqual(["10.0.0.1", "10.0.0.2", "10.0.0.4"])
  })

  it("reports changed, unchanged and one-sided devices, and writes the diff files", async () => {
    const { rows, messages, ctx } = fakeCtx(runDir)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await compareConfig.run(ctx as any, { beforeFolder: beforeDir, afterFolder: afterDir, ignore: DEFAULT_IGNORE.join("\n"), context: 3 })

    const byIp = Object.fromEntries(rows.map((r) => [r["IP Address"], r]))
    expect(byIp["10.0.0.1"]).toMatchObject({ Device: "SW_CORE", Status: "Changed", "Lines Added": "1", "Lines Removed": "1" })
    expect(String(byIp["10.0.0.1"].Diff)).toContain("-logging host 10.1.1.1")
    expect(String(byIp["10.0.0.1"].Diff)).toContain("+logging host 10.9.9.9")
    // "ntp clock-period" differs in both files but is on the ignore list, so it is not a change.
    expect(String(byIp["10.0.0.1"].Diff)).not.toContain("ntp clock-period")
    expect(byIp["10.0.0.2"]).toMatchObject({ Status: "Same", Diff: "No difference." })
    expect(byIp["10.0.0.3"]).toMatchObject({ Status: "Missing in After" })
    expect(byIp["10.0.0.4"]).toMatchObject({ Status: "New in After" })
    expect(messages).toContain("summary: 1 changed, 1 unchanged, 2 on one side only")

    const written = fs.readdirSync(runDir)
    expect(written.filter((f) => f.endsWith(".diff")).length).toBe(2) // one per changed device + the combined report
    expect(fs.readFileSync(path.join(runDir, "SW_CORE-10.0.0.1.diff"), "utf8")).toContain("+logging host 10.9.9.9")
    expect(messages.some((m) => m.startsWith("artifact: compare_"))).toBe(true)
  })

  it("only lists the devices that changed when asked to", async () => {
    const { rows, ctx } = fakeCtx(runDir)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await compareConfig.run(ctx as any, { beforeFolder: beforeDir, afterFolder: afterDir, onlyChanged: true })
    expect(rows.map((r) => r["IP Address"])).toEqual(["10.0.0.1"])
  })

  it("refuses two folders that are the same, or a folder that is not there", async () => {
    const same = fakeCtx(runDir)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await compareConfig.run(same.ctx as any, { beforeFolder: beforeDir, afterFolder: beforeDir })
    expect(same.rows).toHaveLength(0)
    expect(same.messages.join()).toMatch(/same folder/i)

    const missing = fakeCtx(runDir)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await compareConfig.run(missing.ctx as any, { beforeFolder: path.join(base, "nope"), afterFolder: afterDir })
    expect(missing.messages.join()).toMatch(/Before folder not found/)
  })
})

describe("side-by-side view", () => {
  it("pairs a removed line with the added one that replaced it", () => {
    const text = unifiedDiff(["a", "old", "c"], ["a", "new", "c"], 1).text
    expect(parseUnified(text)).toEqual([
      { type: "same", left: { no: 1, text: "a" }, right: { no: 1, text: "a" } },
      { type: "chg", left: { no: 2, text: "old" }, right: { no: 2, text: "new" } },
      { type: "same", left: { no: 3, text: "c" }, right: { no: 3, text: "c" } },
    ])
  })

  it("leaves the other side empty for a pure insert or delete, and keeps both line numbers honest", () => {
    const rows = parseUnified(unifiedDiff(["a", "c"], ["a", "b1", "b2", "c"], 0).text)
    expect(rows.map((r) => `${r.type}:${r.left?.text ?? ""}/${r.right?.text ?? ""}`)).toEqual(["add:/b1", "add:/b2"])
    expect(rows[1].right).toEqual({ no: 3, text: "b2" })

    const removed = parseUnified(unifiedDiff(["a", "b", "c"], ["a", "c"], 0).text)
    expect(removed.map((r) => `${r.type}:${r.left?.text ?? ""}/${r.right?.text ?? ""}`)).toEqual(["del:b/"])
  })

  it("marks where lines were skipped between two hunks", () => {
    const before = ["x", ...Array.from({ length: 20 }, (_, i) => `line ${i}`), "y"]
    const after = ["X", ...Array.from({ length: 20 }, (_, i) => `line ${i}`), "Y"]
    const rows = parseUnified(unifiedDiff(before, after, 1).text)
    const gap = rows.find((r) => r.type === "gap")
    expect(gap).toBeTruthy()
    expect(gap!.skipped).toBe(18) // the 20 unchanged lines minus one of context on each side
    expect(looksLikeDiff(unifiedDiff(before, after, 1).text)).toBe(true)
    expect(looksLikeDiff("show version\nCisco IOS")).toBe(false)
  })

  it("whole-file mode keeps every line, so the view can be scrolled end to end", () => {
    const before = ["a", "b", "c", "d", "e"]
    const after = ["a", "b", "C", "d", "e"]
    const rows = parseUnified(unifiedDiff(before, after, Number.MAX_SAFE_INTEGER).text)
    expect(rows).toHaveLength(5)
    expect(rows.filter((r) => r.type === "same")).toHaveLength(4)
    expect(rows.some((r) => r.type === "gap")).toBe(false)
  })
})
