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
]

/**
 * Commands whose output is different every time it is run and says nothing about what was changed:
 * a routing table's ages, ARP and MAC ages, the log, process counters. Comparing a 55,000-line
 * "show ip route ospf" line by line after a reload reports 40,000 differences and hides the one
 * "show run" line that actually moved - so these are skipped unless the user asks for them.
 */
export const DEFAULT_SKIP = [
  "^show ip route",
  "^show ip bgp",
  "^show ip arp",
  "^show mac address",
  "^show logging",
  "^show process",
  "^show clock",
  "^show interfaces?$",
  // Temperatures, fan speeds and voltages move by themselves on every reading. Take this line out of the
  // list when the point of the comparison is the hardware (a PSU or fan that stopped).
  "^show environment",
]

/**
 * Secrets in a config: the hash changes when the password is rotated, so the line still reports as changed -
 * only the value is hidden. Group 1 is what gets replaced, so each pattern keeps the part that identifies
 * the line and masks the rest.
 */
export const SECRET_PATTERNS: [RegExp, string][] = [
  // A secret introduced by its encryption type: "secret 9 $9$…", "password 7 …", "key 7 …", "md5 7 …".
  // Not anchored to the start of the line - IOS puts them in the middle:
  //   username network privilege 15 secret 9 $9$KHSe…
  //   client 10.8.72.23 server-key 7 132E2330…
  // The lookbehind keeps "key" from matching the tail of "message-digest-key 1 md5 7 <hash>", where the 1 is
  // a key id and the hash sits further along the line.
  [/(?<![\w-])(password|secret|key|server-key|key-string|pre-shared-key|shared-secret|md5|wpa-psk)(\s+[0-9])\s+\S+/gi, "$1$2 ********"],
  // The same keywords in clear text (no type digit), plus the ones that never carry one.
  [/(?<![\w-])(password|secret|server-key|key-string|pre-shared-key|shared-secret|community)\s+(?![0-9]\s)\S+/gi, "$1 ********"],
  // SNMPv3: "auth sha <pass> priv aes 128 <pass>".
  [/\b(auth\s+(?:md5|sha\d*)|priv\s+(?:aes|des|3des)(?:\s+\d+)?)\s+\S+/gi, "$1 ********"],
]

/**
 * Hide the value of a secret while keeping the fact that the line is there.
 *
 * This runs on the **printed** diff, never before it: masking two different hashes first would make them
 * equal, and a password that somebody rotated would silently stop being a change. Diff on the real values,
 * hide the values afterwards - the line still shows up in red/green, with the secret unreadable.
 */
export function maskSecrets(line: string): string {
  let out = line
  // Every pattern is applied: one line can hold two secrets ("auth sha X priv aes Y").
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement)
  return out
}

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

export interface Section { command: string; text: string }

/** The whole file when it has no markers at all - an upload from somewhere else still compares. */
export const WHOLE_FILE = "(whole file)"
/**
 * Exactly the marker Config Devices writes: "--- show run ---". Three dashes, not two or twenty, and a name
 * with something other than dashes in it - device output is full of separator lines like
 * "----- -----      ----------" and "-------------------------", and a looser pattern turns every one of
 * them into a bogus command section.
 */
const HEADER = /^--- (.*[A-Za-z0-9].*) ---$/

/**
 * Config Devices writes each command's output under a "--- show run ---" marker. Splitting on those
 * turns one comparison of two 58,000-line logs into one comparison per command, which is how an
 * engineer reads them anyway: "show run changed, the routing table is just older".
 */
export function splitSections(text: string): Section[] {
  const lines = text.replace(/\r/g, "").split("\n")
  const sections: Section[] = []
  let current: string[] = []
  let command = ""
  const flush = () => {
    const body = current.join("\n").trim()
    if (command || body) sections.push({ command: command || WHOLE_FILE, text: body })
    current = []
  }
  for (const line of lines) {
    const head = HEADER.exec(line.trim())
    // "[Command List]" and the commands under it are a preamble, not output - they belong to no command.
    if (head && !/^\[/.test(head[1])) { flush(); command = head[1]; continue }
    current.push(line)
  }
  flush()
  return sections.filter((s) => s.command !== WHOLE_FILE || s.text !== "" || sections.length === 1)
}

export const isSkipped = (command: string, patterns: RegExp[]) => patterns.some((re) => re.test(command))

/** The label used when a row is about the device as a whole rather than one command. */
export const ALL_COMMANDS = "(all commands)"

/** Sections by command name; the same command twice in one log (it happens) keeps both outputs. */
export function byCommand(sections: Section[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const s of sections) map.set(s.command, map.has(s.command) ? `${map.get(s.command)}\n${s.text}` : s.text)
  return map
}

/** Myers diff of the part that actually differs - the common head and tail are cheap to strip first. */
/** Myers is quadratic in how much two files differ, so it only ever sees a short stretch of them. */
const SMALL = 1500
const MAX_EDITS = 1500
const MAX_DEPTH = 24

const same = (l: string): Op => ({ type: "=", line: l })
const removed = (l: string): Op => ({ type: "-", line: l })
const added = (l: string): Op => ({ type: "+", line: l })

/**
 * Line diff of two files. The common head and tail are stripped, then the rest is split on **anchors** -
 * lines that appear exactly once in each file, in the same order (patience diff, the same idea git uses).
 * A device config is full of them (`interface GigabitEthernet1/0/1`, `hostname X`), so two 60,000-line
 * backups become hundreds of short stretches that Myers can align exactly, instead of one search so wide
 * that it has to give up and call the whole file replaced.
 */
export function diffLines(before: string[], after: string[]): Op[] {
  return trimmed(before, after, 0)
}

/** Equal ends cost nothing to match and shrink what is left to align. */
function trimmed(a: string[], b: string[], depth: number): Op[] {
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  return [
    ...a.slice(0, head).map(same),
    ...split(a.slice(head, a.length - tail), b.slice(head, b.length - tail), depth),
    ...a.slice(a.length - tail).map(same),
  ]
}

function split(a: string[], b: string[], depth: number): Op[] {
  if (!a.length) return b.map(added)
  if (!b.length) return a.map(removed)
  if (depth >= MAX_DEPTH || (a.length <= SMALL && b.length <= SMALL)) return myers(a, b, MAX_EDITS)
  const anchors = anchorsOf(a, b)
  if (!anchors.length) return myers(a, b, MAX_EDITS)
  const ops: Op[] = []
  let ai = 0, bi = 0
  for (const [x, y] of anchors) {
    ops.push(...trimmed(a.slice(ai, x), b.slice(bi, y), depth + 1), same(a[x]))
    ai = x + 1
    bi = y + 1
  }
  ops.push(...trimmed(a.slice(ai), b.slice(bi), depth + 1))
  return ops
}

/**
 * Lines that occur exactly once on each side, kept only where they run in the same order on both
 * (longest increasing subsequence). Those pairs are certain matches, so each gap between them can be
 * diffed on its own.
 */
export function anchorsOf(a: string[], b: string[]): [number, number][] {
  const once = (lines: string[]) => {
    const seen = new Map<string, number>()
    for (let i = 0; i < lines.length; i++) seen.set(lines[i], seen.has(lines[i]) ? -1 : i)
    return seen
  }
  const inA = once(a), inB = once(b)
  const pairs: [number, number][] = []
  for (const [line, i] of inA) {
    const j = inB.get(line)
    if (i >= 0 && j !== undefined && j >= 0) pairs.push([i, j])
  }
  pairs.sort((p, q) => p[0] - q[0])

  // Longest increasing subsequence over the other file's positions - patience sorting, O(n log n).
  const tails: number[] = [], from: number[] = new Array(pairs.length).fill(-1), at: number[] = []
  for (let k = 0; k < pairs.length; k++) {
    const y = pairs[k][1]
    let lo = 0, hi = tails.length
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < y) lo = mid + 1; else hi = mid }
    tails[lo] = y
    at[lo] = k
    from[k] = lo > 0 ? at[lo - 1] : -1
  }
  const out: [number, number][] = []
  for (let k = tails.length ? at[tails.length - 1] : -1; k >= 0; k = from[k]) out.push(pairs[k])
  return out.reverse()
}

function myers(a: string[], b: string[], maxEdits: number): Op[] {
  const n = a.length, m = b.length
  if (!n && !m) return []
  if (!n) return b.map(added)
  if (!m) return a.map(removed)
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
export function unifiedDiff(before: string[], after: string[], context = 3, mask = false): DiffResult {
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
    hunk.push(`${op.type === "=" ? " " : op.type}${mask ? maskSecrets(op.line) : op.line}`)
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

const COLUMNS = ["Device", "IP Address", "Command", "Status", "Lines Added", "Lines Removed", "Diff"]
const EXPORT = ["Device", "IP Address", "Command", "Status", "Lines Added", "Lines Removed", "Before File", "After File", "Diff File"]

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
    { name: "skip", label: "Skip these commands (one regex per line)", type: "textarea", rows: 5, default: DEFAULT_SKIP.join("\n"),
      help: "Matched against the '--- show … ---' markers Config Devices writes. Routing tables, ARP, MAC and logs differ on " +
        "every run (route ages, counters) and would bury the real change. Leave empty to compare every command." },
    { name: "ignore", label: "Ignore lines matching (one regex per line)", type: "textarea", rows: 5, default: DEFAULT_IGNORE.join("\n"),
      help: "Lines that change on their own between two runs. Leave empty to compare everything." },
    { name: "context", label: "Context lines", type: "number", default: 3, min: 0, max: 20, width: "half",
      showIf: { wholeFile: "false" }, help: "Unchanged lines kept around each change." },
    { name: "wholeFile", label: "Keep the whole file (side-by-side like MobaDiff/WinMerge)", type: "checkbox", default: false, width: "half",
      help: "Every line of both files is kept, so the View window can be scrolled end to end. Heavier for big configs." },
    { name: "onlyChanged", label: "Show only devices that changed", type: "checkbox", default: false, width: "half" },
    { name: "maskSecrets", label: "Mask passwords and keys in the diff", type: "checkbox", default: false, width: "half",
      help: "Replaces the value after 'enable secret', 'username … password', 'key 7 …', 'snmp-server community', " +
        "TACACS/RADIUS keys and pre-shared keys with ********. The line still shows as changed when the secret was " +
        "rotated - only the value is hidden, so the diff is safe to send on." },
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
    const skip = compileIgnore(str(params.skip, DEFAULT_SKIP.join("\n")))
    // "Whole file" keeps every unchanged line, which is what makes the side-by-side view scrollable end to end.
    const context = bool(params.wholeFile) ? Number.MAX_SAFE_INTEGER : Math.max(0, Math.min(20, Number(params.context) || 3))
    const onlyChanged = bool(params.onlyChanged)
    const mask = bool(params.maskSecrets)
    const before = scanFolder(beforeDir), after = scanFolder(afterDir)
    if (!before.size && !after.size) { ctx.error("No .log files in either folder."); return }
    ctx.info(`Before: ${before.size} device log(s), After: ${after.size} device log(s).`)

    const keys = [...new Set([...before.keys(), ...after.keys()])].sort()
    ctx.setColumns(COLUMNS, EXPORT)
    ctx.progress(0, keys.length)
    const report: string[] = [`Compare Configuration`, `Before: ${beforeDir}`, `After : ${afterDir}`, ""]
    let changedDevices = 0, sameDevices = 0, missing = 0, changedCommands = 0
    const skippedCommands = new Set<string>()

    for (const key of keys) {
      ctx.checkStop()
      const b = before.get(key), a = after.get(key)
      const device = (a ?? b)!.hostname, ip = (a ?? b)!.ip
      const row = (command: string, status: string, diff = "", addedLines = "", removedLines = "") => ({
        Device: device, "IP Address": ip, Command: command, Status: status, "Lines Added": addedLines,
        "Lines Removed": removedLines, Diff: diff, "Before File": b?.file ?? "", "After File": a?.file ?? "", "Diff File": "",
      })
      if (!b || !a) {
        missing++
        const status = b ? "Missing in After" : "New in After"
        if (!onlyChanged) ctx.addRow(row(ALL_COMMANDS, status, b ? "This device has no log in the After folder." : "This device has no log in the Before folder."))
        report.push(`### ${device} (${ip}) - ${status}`, "")
        ctx.step()
        continue
      }
      try {
        const beforeSections = byCommand(splitSections(fs.readFileSync(b.file, "utf8")))
        const afterSections = byCommand(splitSections(fs.readFileSync(a.file, "utf8")))
        const commands = [...afterSections.keys(), ...[...beforeSections.keys()].filter((c) => !afterSections.has(c))]
        const changes: { command: string; diff: DiffResult }[] = []

        for (const command of commands) {
          ctx.checkStop()
          if (isSkipped(command, skip)) { skippedCommands.add(command); continue }
          const bs = beforeSections.get(command), as = afterSections.get(command)
          if (bs === undefined || as === undefined) {
            changedCommands++
            const status = bs === undefined ? "Only in After" : "Only in Before"
            const text = normalize(bs ?? as ?? "", ignore).map((l) => `${bs === undefined ? "+" : "-"}${mask ? maskSecrets(l) : l}`)
            const diff: DiffResult = { text: [`@@ -1,${bs === undefined ? 0 : text.length} +1,${bs === undefined ? text.length : 0} @@`, ...text].join("\n"),
              added: bs === undefined ? text.length : 0, removed: bs === undefined ? 0 : text.length }
            changes.push({ command, diff })
            ctx.addRow(row(command, status, diff.text, String(diff.added), String(diff.removed)))
            continue
          }
          const diff = unifiedDiff(normalize(bs, ignore), normalize(as, ignore), context, mask)
          if (!diff.text) continue
          changedCommands++
          changes.push({ command, diff })
          ctx.addRow(row(command, "Changed", diff.text, String(diff.added), String(diff.removed)))
        }

        if (!changes.length) {
          sameDevices++
          if (!onlyChanged) ctx.addRow(row(ALL_COMMANDS, "Same", "No difference in the commands that were compared."))
        } else {
          changedDevices++
          const file = path.join(ctx.runDir, `${safeName(device)}-${safeName(ip)}.diff`)
          fs.writeFileSync(file, [`--- ${b.file}`, `+++ ${a.file}`, "",
            ...changes.flatMap((c) => [`### ${c.command}  (+${c.diff.added} / -${c.diff.removed})`, c.diff.text, ""])].join("\n"), "utf8")
          report.push(`### ${device} (${ip}) - ${changes.length} command(s) changed`, `--- ${b.file}`, `+++ ${a.file}`, "",
            ...changes.flatMap((c) => [`## ${c.command}  (+${c.diff.added} / -${c.diff.removed})`, c.diff.text, ""]))
        }
      } catch (e) {
        ctx.addRow(row(ALL_COMMANDS, "Error", (e as Error).message))
        ctx.warn(`Could not compare ${device} (${ip}): ${(e as Error).message}`)
      }
      ctx.step()
    }

    if (changedDevices) {
      const file = path.join(ctx.runDir, `compare_${stamp()}.diff`)
      fs.writeFileSync(file, report.join("\n"), "utf8")
      ctx.artifact(path.basename(file), file)
    }
    if (skippedCommands.size) {
      ctx.info(`Skipped ${skippedCommands.size} command(s) whose output changes by itself: ${[...skippedCommands].join(", ")}. ` +
        "Clear the skip list to compare them too.")
    }
    ctx.summary(`${changedDevices} device(s) changed (${changedCommands} command(s)), ${sameDevices} unchanged, ${missing} on one side only`)
    ctx.info(changedDevices ? `${changedDevices} device(s) changed. The full diff is in ${ctx.runDir}.`
      : `No difference between the two runs (${sameDevices} device(s) compared).`)
  },
}
