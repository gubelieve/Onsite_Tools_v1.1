"use client"

import * as React from "react"
import { Download, FileArchive, FolderOpen, Square } from "lucide-react"
import { Badge } from "@astryxdesign/core/Badge"
import { Button } from "@astryxdesign/core/Button"
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog"
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout"
import { ProgressBar } from "@astryxdesign/core/ProgressBar"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useToast } from "@astryxdesign/core/Toast"
import type { JobSnapshot } from "@/lib/jobs"

const OK = /^(success|pass|completed|connected|connected \(arp\)|done|ok)$/i
const BAD = /^(fail|failed|error|authentication failed\.?|connection error|connection timeout|stopped by user|disconnected|auth failed|timeout|request error|skipped|http [45]\d\d|n\/a$)/i
const BUSY = /^(running|pending|connecting|collecting|processing|warning|partial|info)/i
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

const rowTitle = (row: Record<string, unknown>) =>
  String(row["IP Address"] ?? row["Host"] ?? row["IP Management"] ?? row["Checked On (IP)"] ?? row["Device Switch"] ?? row["Hostname"] ?? "")

/** Live view of one job: polls until it finishes, shows progress, the results table, downloads and the log.
 *  Render it with key={jobId} so switching jobs starts from a clean state. */
export function JobPanel({ jobId, onFinished }: { jobId: string; onFinished?: () => void }) {
  const toast = useToast()
  const [job, setJob] = React.useState<JobSnapshot | null>(null)
  const [filter, setFilter] = React.useState("")
  const [page, setPage] = React.useState(0)
  const [view, setView] = React.useState<{ title: string; text: string } | null>(null)
  const seen = React.useRef(0)
  const finishedRef = React.useRef(onFinished)
  React.useEffect(() => { finishedRef.current = onFinished }, [onFinished])

  React.useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout>, version = -1
    seen.current = 0
    const poll = async () => {
      try {
        const r = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" })
        if (!r.ok) throw new Error((await r.json()).error ?? r.statusText)
        const snap = (await r.json()) as JobSnapshot
        if (!alive) return
        if (snap.version !== version) { version = snap.version; setJob(snap) }
        for (const m of snap.messages) {
          if (m.seq > seen.current) { seen.current = m.seq; toast({ body: m.text, type: m.level === "error" ? "error" : "info" }) }
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
    return f ? job.rows.filter((r) => Object.values(r).some((v) => String(v ?? "").toLowerCase().includes(f))) : job.rows
  }, [job, filter])

  if (!job) return <p className="text-muted-foreground text-sm">Loading job…</p>
  const running = ["queued", "running"].includes(job.status)
  const pct = job.progress.total ? Math.round((job.progress.done / job.progress.total) * 100) : running ? 0 : 100
  const pages = Math.max(1, Math.ceil(rows.length / PAGE))
  const current = Math.min(page, pages - 1)
  const shown = rows.slice(current * PAGE, (current + 1) * PAGE)

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Badge variant={STATUS_VARIANT[job.status] ?? "neutral"} label={job.status.toUpperCase()} />
        <span className="text-muted-foreground text-xs">{job.runLabel} · {job.created}</span>
        <div className="min-w-[180px] flex-1">
          <ProgressBar label="Progress" isLabelHidden value={pct} max={100} isIndeterminate={running && !job.progress.total}
            variant={job.status === "error" || job.status === "stopped" ? "error" : job.status === "done" ? "success" : "accent"} />
        </div>
        {job.progress.total > 0 && <span className="text-muted-foreground text-xs tabular-nums">{job.progress.done}/{job.progress.total} ({pct}%)</span>}
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
              {shown.map((r) => (
                <tr key={r._key} className="hover:bg-muted/50 border-b last:border-0">
                  {job.columns.map((c) => {
                    const text = r[c] === null || r[c] === undefined ? "" : String(r[c])
                    const long = text.length > 80 || text.includes("\n")
                    const variant = long ? null : statusVariant(c, text)
                    return (
                      <td key={c} className="max-w-[420px] px-3 py-1.5 align-top whitespace-nowrap" title={long ? undefined : text}>
                        {variant ? <Badge variant={variant} label={text} /> : long ? (
                          <span className="flex items-center gap-2">
                            <span className="truncate font-mono text-xs">{text.replace(/\s+/g, " ").slice(0, 70)}…</span>
                            <Button variant="ghost" size="sm" label="View" onClick={() => setView({ title: `${c} — ${rowTitle(r)}`, text })} />
                          </span>
                        ) : <span className="block truncate">{text}</span>}
                      </td>
                    )
                  })}
                </tr>
              ))}
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

      {view && (
        <Dialog isOpen onOpenChange={(open) => { if (!open) setView(null) }} purpose="info" width={1000}>
          <Layout
            header={<DialogHeader title={view.title} onOpenChange={() => setView(null)} />}
            content={<LayoutContent><pre className="max-h-[65vh] overflow-auto font-mono text-xs whitespace-pre">{view.text}</pre></LayoutContent>}
            footer={
              <LayoutFooter hasDivider>
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" label="Copy" clickAction={async () => { await navigator.clipboard.writeText(view.text); toast({ body: "Copied to clipboard" }) }} />
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
