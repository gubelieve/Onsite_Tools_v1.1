"use client"

import * as React from "react"
import { ChevronDown, ChevronLeft, ChevronRight, Download, FileArchive, FolderOpen, Square } from "lucide-react"
import { Badge } from "@astryxdesign/core/Badge"
import { Button } from "@astryxdesign/core/Button"
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog"
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout"
import { ProgressBar } from "@astryxdesign/core/ProgressBar"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useToast } from "@astryxdesign/core/Toast"
import { DiffView } from "@/components/diff-view"
import { looksLikeDiff } from "@/lib/diff-format"
import type { JobSnapshot } from "@/lib/jobs"

const OK = /^(success|pass|completed|connected|connected \(arp\)|done|ok|same)$/i
const BAD = /^(fail|failed|error|authentication failed\.?|connection error|connection timeout|stopped by user|disconnected|auth failed|timeout|request error|skipped|http [45]\d\d|n\/a$)/i
const BUSY = /^(running|pending|connecting|collecting|processing|warning|partial|info|changed|missing in|new in)/i
const PAGE = 200

type BadgeVariant = "green" | "red" | "yellow" | "neutral" | "info"
const STATUS_VARIANT: Record<string, BadgeVariant> = { running: "yellow", queued: "info", done: "green", stopped: "red", error: "red" }

function statusVariant(col: string, value: string): BadgeVariant | null {
  if (!/status|stage/i.test(col) && !OK.test(value) && !BAD.test(value)) return null
  if (OK.test(value)) return "green"
  if (BAD.test(value)) return /^n\/a$/i.test(value) && !/status/i.test(col) ? null : "red"
  if (BUSY.test(value)) return "yellow"
  return null
}

/** Progress is counted in devices for most tools and in bytes for a file transfer - show MB when it is bytes. */
const amount = (n: number, total: number) => (total > 100_000 ? `${Math.round(n / 1048576).toLocaleString()} MB` : n.toLocaleString())

/** A cell that may be missing, as a string for the diff header (file paths live in export-only columns). */
const cellText = (v: unknown) => (v === null || v === undefined ? undefined : String(v) || undefined)

const rowTitle = (row: Record<string, unknown>) =>
  String(row["IP Address"] ?? row["Host"] ?? row["IP Management"] ?? row["Checked On (IP)"] ?? row["Device Switch"] ?? row["Hostname"] ?? "")

/** Live view of one job: polls until it finishes, shows progress, the results table, downloads and the log.
 *  Render it with key={jobId} so switching jobs starts from a clean state. */
export function JobPanel({ jobId, onFinished }: { jobId: string; onFinished?: () => void }) {
  const toast = useToast()
  const [job, setJob] = React.useState<JobSnapshot | null>(null)
  const [filter, setFilter] = React.useState("")
  const [page, setPage] = React.useState(0)
  // Which cell is open in the viewer: a column plus a position in the rows below, so Next can walk them.
  const [view, setView] = React.useState<{ column: string; at: number } | null>(null)
  const [closed, setClosed] = React.useState<Set<string>>(new Set())
  const seen = React.useRef(0)
  const finishedRef = React.useRef(onFinished)
  React.useEffect(() => { finishedRef.current = onFinished }, [onFinished])

  React.useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout>, version = -1
    seen.current = 0
    const poll = async () => {
      try {
        // Ask only for what changed: the server answers "unchanged" instead of resending the whole run.
        const r = await fetch(`/api/jobs/${jobId}${version >= 0 ? `?version=${version}` : ""}`, { cache: "no-store" })
        if (!r.ok) throw new Error((await r.json()).error ?? r.statusText)
        const snap = (await r.json()) as JobSnapshot & { unchanged?: boolean }
        if (!alive) return
        if (snap.unchanged) { timer = setTimeout(poll, 1000); return }
        if (snap.version !== version) { version = snap.version; setJob(snap) }
        for (const m of snap.messages) {
          if (m.seq <= seen.current) continue
          seen.current = m.seq
          // Only what needs attention interrupts. Progress notes would otherwise stack up over the results;
          // they are on the line under the progress bar and in the log.
          if (m.level === "error" || m.level === "warning") toast({ body: m.text, type: m.level === "error" ? "error" : "info" })
        }
        if (["queued", "running"].includes(snap.status)) timer = setTimeout(poll, 1000)
        else finishedRef.current?.()
      } catch (e) {
        if (alive) toast({ body: `Lost the job: ${(e as Error).message}`, type: "error" })
      }
    }
    void poll()
    return () => { alive = false; clearTimeout(timer) }
  }, [jobId, toast])

  const rows = React.useMemo(() => {
    if (!job) return []
    const f = filter.trim().toLowerCase()
    const found = f ? job.rows.filter((r) => Object.values(r).some((v) => String(v ?? "").toLowerCase().includes(f))) : job.rows
    // An upgrade keeps adding rows for an hour; the one that just happened is the one being watched.
    return job.latestFirst ? [...found].reverse() : found
  }, [job, filter])

  if (!job) return <p className="text-muted-foreground text-sm">Loading job…</p>
  const running = ["queued", "running"].includes(job.status)
  const pct = job.progress.total ? Math.round((job.progress.done / job.progress.total) * 100) : running ? 0 : 100
  const pages = Math.max(1, Math.ceil(rows.length / PAGE))
  const current = Math.min(page, pages - 1)
  const shown = rows.slice(current * PAGE, (current + 1) * PAGE)

  // One fold-out per value of the group column (Compare Configuration: one per device).
  const groupBy = job.groupBy && job.columns.includes(job.groupBy) ? job.groupBy : ""
  const groups: [string, typeof rows][] = []
  if (groupBy) {
    for (const r of shown) {
      const key = String(r[groupBy] ?? "")
      const last = groups.at(-1)
      if (last && last[0] === key) last[1].push(r)
      else groups.push([key, [r]])
    }
  }
  const toggle = (key: string) => setClosed((was) => {
    const next = new Set(was)
    if (!next.delete(key)) next.add(key)
    return next
  })
  const summarise = (group: typeof rows) => {
    const tally = new Map<string, number>()
    for (const r of group) { const s = String(r.Status ?? "").trim(); if (s) tally.set(s, (tally.get(s) ?? 0) + 1) }
    const counts = [...tally].map(([s, n]) => `${n} ${s}`).join(" · ")
    return `${group.length} row(s)${counts ? ` · ${counts}` : ""}`
  }

  // Everything the viewer can step through with Next: the rows that actually have something in that column.
  const navRows = view ? rows.filter((r) => String(r[view.column] ?? "").trim()) : []
  const at = view ? Math.min(Math.max(0, view.at), Math.max(0, navRows.length - 1)) : 0
  const viewRow = view ? navRows[at] : undefined
  const viewText = view && viewRow ? String(viewRow[view.column] ?? "") : ""
  const viewTitle = view && viewRow
    ? `${view.column} — ${[groupBy ? String(viewRow[groupBy] ?? "") : "", rowTitle(viewRow), String(viewRow.Command ?? "")]
        .filter((x, i, a) => x && a.indexOf(x) === i).join(" · ")}`
    : ""
  /** What the table draws: a fold-out header per group (when grouped), then its rows unless it is closed. */
  type Line = { group: string; rows: typeof rows } | { row: (typeof rows)[number] }
  const lines: Line[] = groupBy
    ? groups.flatMap(([key, group]): Line[] => [{ group: key, rows: group }, ...(closed.has(key) ? [] : group.map((row) => ({ row })))])
    : shown.map((row) => ({ row }))

  const openView = (column: string, row: (typeof rows)[number]) => {
    const list = rows.filter((r) => String(r[column] ?? "").trim())
    setView({ column, at: Math.max(0, list.indexOf(row)) })
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Badge variant={STATUS_VARIANT[job.status] ?? "neutral"} label={job.status.toUpperCase()} />
        <span className="text-muted-foreground text-xs">{job.runLabel} · {job.created}</span>
        <div className="min-w-[180px] flex-1">
          <ProgressBar label="Progress" isLabelHidden value={pct} max={100} isIndeterminate={running && !job.progress.total}
            variant={job.status === "error" || job.status === "stopped" ? "error" : job.status === "done" ? "success" : "accent"} />
        </div>
        {job.progress.total > 0 && (
          <span className="text-muted-foreground text-xs tabular-nums">{amount(job.progress.done, job.progress.total)}/{amount(job.progress.total, job.progress.total)} ({pct}%)</span>
        )}
        {job.summary && <span className="text-primary text-sm font-semibold">{job.summary}</span>}
        {running && (
          <Button variant="destructive" size="sm" label="Stop" icon={<Square className="h-3.5 w-3.5" />}
            clickAction={async () => { await fetch(`/api/jobs/${job.id}/stop`, { method: "POST" }); toast({ body: "Stop requested - sessions finish their current command." }) }} />
        )}
        {job.rows.length > 0 && <Button variant="secondary" size="sm" label="Export CSV" icon={<Download className="h-3.5 w-3.5" />} href={`/api/jobs/${job.id}/export`} />}
        {(job.runDir || job.logs.length > 0) && (
          // One file with the results, the run log and every per-device log of this run.
          <Button variant="secondary" size="sm" label="Zip log files" icon={<FileArchive className="h-3.5 w-3.5" />} href={`/api/jobs/${job.id}/logs`} />
        )}
      </div>

      {/* What the run is doing right now. It used to be a toast per message, which buried the results. */}
      {job.messages.length > 0 && (
        <p className={`mb-2 truncate text-xs ${job.messages.at(-1)!.level === "error" ? "text-destructive" : "text-muted-foreground"}`}
          title={job.messages.map((m) => `${m.ts} ${m.text}`).join("\n")}>
          {job.messages.at(-1)!.ts} · {job.messages.at(-1)!.text}
          {job.messages.length > 1 && <span className="ml-2 opacity-60">({job.messages.length} messages — hover, or see the log below)</span>}
        </p>
      )}

      {job.error && <p className="text-destructive mb-2 text-sm">{job.error}</p>}
      {(job.artifacts.length > 0 || job.runDir) && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {job.artifacts.slice(0, 30).map((a) => (
            <Button key={a.index} variant="ghost" size="sm" label={a.name} icon={<Download className="h-3.5 w-3.5" />} href={`/api/jobs/${job.id}/artifact/${a.index}`} />
          ))}
          {job.runDir && <span className="text-muted-foreground inline-flex items-center gap-1 text-xs" title={job.runDir}><FolderOpen className="h-3.5 w-3.5" />{job.runDir}</span>}
        </div>
      )}

      <div className="mb-2 flex flex-wrap items-center gap-3">
        <div className="w-64"><TextInput label="Filter rows" isLabelHidden placeholder="Filter rows…" value={filter} onChange={(v) => { setFilter(v); setPage(0) }} hasClear size="sm" /></div>
        <span className="text-muted-foreground text-xs">{rows.length} row(s)</span>
        {groupBy && groups.length > 1 && (
          <Button variant="ghost" size="sm" label={closed.size ? `Expand all ${groups.length}` : "Collapse all"}
            icon={closed.size ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            onClick={() => setClosed(closed.size ? new Set() : new Set(groups.map(([k]) => k)))} />
        )}
        {pages > 1 && (
          <span className="flex items-center gap-1 text-xs">
            <Button variant="ghost" size="sm" label="Prev" isDisabled={current === 0} onClick={() => setPage(current - 1)} />
            page {current + 1}/{pages}
            <Button variant="ghost" size="sm" label="Next" isDisabled={current >= pages - 1} onClick={() => setPage(current + 1)} />
          </span>
        )}
      </div>

      <div className="result-table max-h-[60vh] overflow-auto rounded-xl border">
        {job.columns.length === 0 ? <p className="text-muted-foreground p-3 text-sm">No results yet.</p> : (
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>{job.columns.map((c) => <th key={c} className="bg-muted sticky top-0 z-[1] border-b px-3 py-2 text-left font-semibold whitespace-nowrap">{c}</th>)}</tr>
            </thead>
            <tbody>
              {lines.map((line) => ("group" in line ? (
                <tr key={`group:${line.group}`} className="bg-muted/60 border-b">
                  <td className="px-3 py-1.5" colSpan={job.columns.length}>
                    <button type="button" className="flex w-full items-center gap-2 text-left" onClick={() => toggle(line.group)}>
                      {closed.has(line.group) ? <ChevronRight className="h-4 w-4 shrink-0" /> : <ChevronDown className="h-4 w-4 shrink-0" />}
                      <b className="truncate">{line.group || `(no ${groupBy})`}</b>
                      <span className="text-muted-foreground text-xs">{summarise(line.rows)}</span>
                    </button>
                  </td>
                </tr>
              ) : (
                <tr key={line.row._key} className="hover:bg-muted/50 border-b last:border-0">
                  {job.columns.map((c) => {
                    const text = line.row[c] === null || line.row[c] === undefined ? "" : String(line.row[c])
                    // A "Progress" column holds a percentage - a moving bar says more than a number.
                    if (/^progress$/i.test(c) && text !== "" && Number.isFinite(Number(text))) {
                      const pct = Math.max(0, Math.min(100, Number(text)))
                      return (
                        <td key={c} className="px-3 py-1.5 align-middle whitespace-nowrap">
                          <span className="flex items-center gap-2">
                            <span className="w-28"><ProgressBar label={`${pct}%`} isLabelHidden value={pct} max={100}
                              variant={pct >= 100 ? "success" : "accent"} /></span>
                            <span className="text-muted-foreground tabular-nums text-xs">{pct.toFixed(0)}%</span>
                          </span>
                        </td>
                      )
                    }
                    const long = text.length > 80 || text.includes("\n")
                    const variant = long ? null : statusVariant(c, text)
                    return (
                      <td key={c} className="max-w-[420px] px-3 py-1.5 align-top whitespace-nowrap" title={long ? undefined : text}>
                        {variant ? <Badge variant={variant} label={text} /> : long ? (
                          <span className="flex items-center gap-2">
                            <span className="truncate font-mono text-xs">{text.replace(/\s+/g, " ").slice(0, 70)}…</span>
                            <Button variant="ghost" size="sm" label="View" onClick={() => openView(c, line.row)} />
                          </span>
                        ) : <span className="block truncate">{text}</span>}
                      </td>
                    )
                  })}
                </tr>
              )))}
            </tbody>
          </table>
        )}
      </div>

      <details className="mt-3">
        <summary className="cursor-pointer text-sm font-semibold">Log</summary>
        <pre className="bg-muted mt-2 max-h-56 overflow-auto rounded-xl p-3 font-mono text-xs whitespace-pre-wrap">
          {job.logs.map((l) => `${l.ts} ${l.level} ${l.text}`).join("\n") || "(empty)"}
        </pre>
      </details>

      {view && viewRow && (
        // A diff is only readable side by side, and that view needs the room.
        <Dialog isOpen onOpenChange={(open) => { if (!open) setView(null) }} purpose="info" width={looksLikeDiff(viewText) ? 1500 : 1000}>
          <Layout
            header={<DialogHeader title={viewTitle} onOpenChange={() => setView(null)} />}
            content={<LayoutContent>{looksLikeDiff(viewText)
              ? <DiffView text={viewText} leftName={cellText(viewRow["Before File"])} rightName={cellText(viewRow["After File"])} />
              : <pre className="max-h-[65vh] overflow-auto font-mono text-xs whitespace-pre">{viewText}</pre>}</LayoutContent>}
            footer={
              <LayoutFooter hasDivider>
                <div className="flex items-center gap-2">
                  {/* Step through every row that has something in this column - checking 20 diffs without closing the window. */}
                  <Button variant="secondary" label="Previous" icon={<ChevronLeft className="h-3.5 w-3.5" />}
                    isDisabled={at <= 0} onClick={() => setView({ column: view.column, at: at - 1 })} />
                  <Button variant="secondary" label="Next" icon={<ChevronRight className="h-3.5 w-3.5" />}
                    isDisabled={at >= navRows.length - 1} onClick={() => setView({ column: view.column, at: at + 1 })} />
                  <span className="text-muted-foreground text-xs tabular-nums">{at + 1} of {navRows.length}</span>
                  <span className="flex-1" />
                  <Button variant="secondary" label="Copy" clickAction={async () => { await navigator.clipboard.writeText(viewText); toast({ body: "Copied to clipboard" }) }} />
                  <Button variant="primary" label="Close" onClick={() => setView(null)} />
                </div>
              </LayoutFooter>
            }
          />
        </Dialog>
      )}
    </div>
  )
}
