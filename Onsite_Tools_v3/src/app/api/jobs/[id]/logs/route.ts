/** One zip with everything a run produced: the results table, the run log, and every file in the run folder. */
import path from "node:path"
import { NextResponse } from "next/server"
import { toCsv } from "@/lib/csv"
import { jobs } from "@/lib/jobs"
import { isInsideApp, safeName, stamp } from "@/lib/paths"
import { folderEntries, zipBuffer, type ZipEntry } from "@/lib/zip"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const snap = await jobs.get((await params).id)
  if (!snap) return NextResponse.json({ error: "Job not found" }, { status: 404 })

  const entries: ZipEntry[] = []
  if (snap.columns.length) entries.push({ name: "results.csv", data: Buffer.from(toCsv(snap.exportColumns ?? snap.columns, snap.rows), "utf8") })
  if (snap.logs.length) {
    const header = `${snap.toolName} - ${snap.runLabel}\nStarted : ${snap.created}\nFinished: ${snap.finished ?? "(still running)"}\n` +
      `Status  : ${snap.status}\nSummary : ${snap.summary}\n\n`
    entries.push({ name: "run.log", data: Buffer.from(header + snap.logs.map((l) => `${l.ts} ${l.level} ${l.text}`).join("\n") + "\n", "utf8") })
  }
  // Only folders this app wrote itself are served - never an arbitrary path from a saved job.
  if (snap.runDir && isInsideApp(snap.runDir)) entries.push(...folderEntries(snap.runDir, path.basename(snap.runDir)))
  if (!entries.length) return NextResponse.json({ error: "This run has no log files yet" }, { status: 404 })

  const name = `${safeName(snap.toolId)}_${snap.runDir ? path.basename(snap.runDir) : stamp()}.zip`
  try {
    const zip = zipBuffer(entries)
    return new NextResponse(new Uint8Array(zip), {
      headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${name}"` },
    })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
