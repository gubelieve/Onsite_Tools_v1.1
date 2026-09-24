/**
 * Compare Configuration - what changed on each device between two Config Devices runs.
 *
 * Config Devices writes one log per device per run (logs/config-devices/<date_time>/<hostname>-<ip>_<stamp>.log).
 * Point this tool at the folder from before the work and the folder from after it; devices are matched by the
 * IP in the file name (hostname when there is no IP), and each pair is diffed line by line.
 */
import fs from "node:fs"
import path from "node:path"
import { safeName, stamp } from "../paths"
import { infoFromLogName } from "./parsers"
import { bool, str, type ToolDef } from "./types"

export type Op = { type: "=" | "-" | "+"; line: string }

/** Lines that differ by themselves between two runs and would bury the real change. */
export const DEFAULT_IGNORE = [
  "^Building configuration",
  "^Current configuration\\s*:",
  "Last configuration change",
  "^ntp clock-period",
  "uptime is",
  "^Time source is",
  "^--- show clock ---$",
]

export function compileIgnore(text: string): RegExp[] {
  const out: RegExp[] = []
  for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    try { out.push(new RegExp(line, "i")) } catch { /* a broken pattern must not stop the comparison */ }
  }
  return out
}

/** A log file as comparable lines: trailing spaces removed, ignored and blank lines dropped. */
export function normalize(text: string, ignore: RegExp[], keepBlank = false): string[] {
  return text.replace(/\r/g, "").split("\n").map((l) => l.replace(/\s+$/, ""))
    .filter((l) => (keepBlank || l !== "") && !ignore.some((re) => re.test(l)))
}

/** Myers diff of the part that actually differs - the common head and tail are cheap to strip first. */
export function diffLines(before: string[], after: string[], maxEdits = 2000): Op[] {
  let head = 0
  while (head < before.length && head < after.length && before[head] === after[head]) head++
  let tail = 0
  while (tail < before.length - head && tail < after.length - head
         && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++
  const a = before.slice(head, before.length - tail)
  const b = after.slice(head, after.length - tail)
  const same = (l: string): Op => ({ type: "=", line: l })
  return [
    ...before.slice(0, head).map(same),
    ...myers(a, b, maxEdits),
    ...before.slice(before.length - tail).map(same),
  ]
}

function myers(a: string[], b: string[], maxEdits: number): Op[] {
  const n = a.length, m = b.length
  if (!n && !m) return []
  if (!n) return b.map((line) => ({ type: "+" as const, line }))
  if (!m) return a.map((line) => ({ type: "-" as const, line }))
  const max = Math.min(n + m, maxEdits)
  const off = max + 1
  let v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) { x++; y++ }
      v[off + k] = x
      if (x >= n && y >= m) return backtrack(a, b, trace, off)
    }
    v = v.slice()
  }
  // Beyond maxEdits the two files have nothing in common worth aligning - show one replaced by the other.
  return [...a.map((line) => ({ type: "-" as const, line })), ...b.map((line) => ({ type: "+" as const, line }))]
}

function backtrack(a: string[], b: string[], trace: Int32Array[], off: number): Op[] {
  const ops: Op[] = []
  let x = a.length, y = b.length
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d]
    const k = x - y
    const prevK = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? k + 1 : k - 1
    const prevX = v[off + prevK]
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) { ops.push({ type: "=", line: a[--x] }); y-- }
    if (d > 0) {
      if (x > prevX) ops.push({ type: "-", line: a[--x] })
      else if (y > prevY) ops.push({ type: "+", line: b[--y] })
    }
  }
  return ops.reverse()
}

export interface DiffResult { text: string; added: number; removed: number }

/** Unified diff with line numbers, so a change can be found again in the real config. */
export function unifiedDiff(before: string[], after: string[], context = 3): DiffResult {
  const ops = diffLines(before, after)
  const added = ops.filter((o) => o.type === "+").length
  const removed = ops.filter((o) => o.type === "-").length
  if (!added && !removed) return { text: "", added, removed }

  // Which "=" lines are close enough to a change to be worth printing.
  const keep = context >= ops.length ? ops.map(() => true) : ops.map((o) => o.type !== "=")
  if (context < ops.length) {
    for (let i = 0; i < ops.length; i++) {
      if (ops[i].type === "=") continue
      for (let j = Math.max(0, i - context); j <= Math.min(ops.length - 1, i + context); j++) keep[j] = true
    }
  }

  const lines: string[] = []
  let beforeNo = 0, afterNo = 0, hunk: string[] = [], hunkBefore = 0, hunkAfter = 0, counts = { b: 0, a: 0 }
  const flush = () => {
    if (!hunk.length) return
    lines.push(`@@ -${hunkBefore},${counts.b} +${hunkAfter},${counts.a} @@`, ...hunk)
    hunk = []
    counts = { b: 0, a: 0 }
  }
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    if (op.type !== "+") beforeNo++
    if (op.type !== "-") afterNo++
    if (!keep[i]) { flush(); continue }
    if (!hunk.length) { hunkBefore = beforeNo; hunkAfter = afterNo }
    if (op.type !== "+") counts.b++
    if (op.type !== "-") counts.a++
    hunk.push(`${op.type === "=" ? " " : op.type}${op.line}`)
  }
  flush()
  return { text: lines.join("\n"), added, removed }
}

/** Device logs in a folder, keyed by IP (or hostname when the file name has no IP). */
export function scanFolder(dir: string): Map<string, { file: string; ip: string; hostname: string }> {
  const found = new Map<string, { file: string; ip: string; hostname: string }>()
  const walk = (current: string) => {
    for (const e of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, e.name)
      if (e.isDirectory()) { walk(full); continue }
      if (!/\.(log|txt)$/i.test(e.name)) continue
      if (e.name.toLowerCase() === "job.log") continue // the run's own log, not a device
      const { ip, hostname } = infoFromLogName(e.name)
      const key = ip !== "Unknown" ? ip : hostname.toLowerCase()
      // Several runs in one folder: the newest file wins, which is what "after" means.
      const previous = found.get(key)
      if (!previous || fs.statSync(full).mtimeMs > fs.statSync(previous.file).mtimeMs) found.set(key, { file: full, ip, hostname })
    }
  }
  walk(dir)
  return found
}

const COLUMNS = ["Device", "IP Address", "Status", "Lines Added", "Lines Removed", "Diff"]
const EXPORT = ["Device", "IP Address", "Status", "Lines Added", "Lines Removed", "Before File", "After File", "Diff File"]

export const compareConfig: ToolDef = {
  id: "compare-config", name: "Compare Configuration", category: "Log Analysis", order: 49, icon: "git-compare",
  description: "Compare the logs of two Config Devices runs (before / after) and show what changed on each device.",
  fields: [
    { name: "beforeFolder", label: "Before: log folder", type: "path", kind: "folder", required: true,
      browseTitle: "Select the BEFORE log folder", placeholder: "…\\Onsite_Tools_v3\\logs\\config-devices\\2026-09-20_180635",
      help: "The folder a Config Devices run wrote before the work (logs/config-devices/<date_time>)." },
    { name: "afterFolder", label: "After: log folder", type: "path", kind: "folder", required: true,
      browseTitle: "Select the AFTER log folder", placeholder: "…\\Onsite_Tools_v3\\logs\\config-devices\\2026-09-21_101500",
      help: "The folder of the run after the work. Devices are matched by the IP in the file name." },
    { name: "ignore", label: "Ignore lines matching (one regex per line)", type: "textarea", rows: 5, default: DEFAULT_IGNORE.join("\n"),
      help: "Lines that change on their own between two runs. Leave empty to compare everything." },
    { name: "context", label: "Context lines", type: "number", default: 3, min: 0, max: 20, width: "half",
      showIf: { wholeFile: "false" }, help: "Unchanged lines kept around each change." },
    { name: "wholeFile", label: "Keep the whole file (side-by-side like MobaDiff/WinMerge)", type: "checkbox", default: false, width: "half",
      help: "Every line of both files is kept, so the View window can be scrolled end to end. Heavier for big configs." },
    { name: "onlyChanged", label: "Show only devices that changed", type: "checkbox", default: false, width: "half" },
  ],
  columns: COLUMNS,
  runs: [{ id: "run", label: "Compare" }],
  async run(ctx, params) {
    const clean = (v: unknown) => str(v).trim().replace(/^"|"$/g, "")
    const beforeDir = clean(params.beforeFolder), afterDir = clean(params.afterFolder)
    for (const [label, dir] of [["Before", beforeDir], ["After", afterDir]] as const) {
      if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) { ctx.error(`${label} folder not found: ${dir || "(empty)"}`); return }
    }
    if (path.resolve(beforeDir) === path.resolve(afterDir)) { ctx.error("Before and After are the same folder - pick the logs of two different runs."); return }

    const ignore = compileIgnore(str(params.ignore, DEFAULT_IGNORE.join("\n")))
    // "Whole file" keeps every unchanged line, which is what makes the side-by-side view scrollable end to end.
    const context = bool(params.wholeFile) ? Number.MAX_SAFE_INTEGER : Math.max(0, Math.min(20, Number(params.context) || 3))
    const onlyChanged = bool(params.onlyChanged)
    const before = scanFolder(beforeDir), after = scanFolder(afterDir)
    if (!before.size && !after.size) { ctx.error("No .log files in either folder."); return }
    ctx.info(`Before: ${before.size} device log(s), After: ${after.size} device log(s).`)

    const keys = [...new Set([...before.keys(), ...after.keys()])].sort()
    ctx.setColumns(COLUMNS, EXPORT)
    ctx.progress(0, keys.length)
    const report: string[] = [`Compare Configuration`, `Before: ${beforeDir}`, `After : ${afterDir}`, ""]
    let changed = 0, same = 0, missing = 0

    for (const key of keys) {
      ctx.checkStop()
      const b = before.get(key), a = after.get(key)
      const device = (a ?? b)!.hostname, ip = (a ?? b)!.ip
      const row = { Device: device, "IP Address": ip, Status: "", "Lines Added": "", "Lines Removed": "", Diff: "",
        "Before File": b?.file ?? "", "After File": a?.file ?? "", "Diff File": "" }
      if (!b || !a) {
        missing++
        row.Status = b ? "Missing in After" : "New in After"
        row.Diff = b ? "This device has no log in the After folder." : "This device has no log in the Before folder."
        if (!onlyChanged) ctx.addRow(row)
        report.push(`### ${device} (${ip}) - ${row.Status}`, "")
        ctx.step()
        continue
      }
      try {
        const diff = unifiedDiff(normalize(fs.readFileSync(b.file, "utf8"), ignore),
                                 normalize(fs.readFileSync(a.file, "utf8"), ignore), context)
        row["Lines Added"] = String(diff.added)
        row["Lines Removed"] = String(diff.removed)
        if (!diff.text) {
          same++
          row.Status = "Same"
          row.Diff = "No difference."
          if (!onlyChanged) ctx.addRow(row)
        } else {
          changed++
          row.Status = "Changed"
          row.Diff = diff.text
          const file = path.join(ctx.runDir, `${safeName(device)}-${safeName(ip)}.diff`)
          fs.writeFileSync(file, `--- ${b.file}\n+++ ${a.file}\n${diff.text}\n`, "utf8")
          row["Diff File"] = file
          ctx.addRow(row)
          report.push(`### ${device} (${ip}) - +${diff.added} / -${diff.removed}`, `--- ${b.file}`, `+++ ${a.file}`, diff.text, "")
        }
      } catch (e) {
        row.Status = "Error"
        row.Diff = (e as Error).message
        ctx.addRow(row)
        ctx.warn(`Could not compare ${device} (${ip}): ${(e as Error).message}`)
      }
      ctx.step()
    }

    if (changed) {
      const file = path.join(ctx.runDir, `compare_${stamp()}.diff`)
      fs.writeFileSync(file, report.join("\n"), "utf8")
      ctx.artifact(path.basename(file), file)
    }
    ctx.summary(`${changed} changed, ${same} unchanged, ${missing} on one side only`)
    ctx.info(changed ? `${changed} device(s) changed between the two runs. The full diff is in ${ctx.runDir}.`
      : `No configuration difference between the two runs (${same} device(s) compared).`)
  },
}
