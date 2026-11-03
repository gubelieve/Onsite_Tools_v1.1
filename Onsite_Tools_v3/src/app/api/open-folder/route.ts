import path from "node:path"
import { NextResponse } from "next/server"
import { jobs } from "@/lib/jobs"
import { isLocalRequest, openFolder } from "@/lib/local-desktop"
import { ensureDir, isInsideApp, LOGS_DIR, safeName } from "@/lib/paths"
import { getTool } from "@/lib/tools"

export const dynamic = "force-dynamic"

/**
 * "Open Directory": shows a run's log folder (or a tool's whole logs/<tool>/ folder) in Explorer on this PC.
 * The browser names a job or a tool, never a path - only folders this app wrote itself can be opened.
 */
export async function POST(req: Request) {
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "Open Directory only works in a browser on the PC that runs the app - use \"Zip log files\" instead." }, { status: 403 })
  }
  const body = (await req.json().catch(() => ({}))) as { jobId?: unknown; toolId?: unknown }
  let dir = ""
  if (typeof body.jobId === "string" && body.jobId) {
    const snap = await jobs.get(body.jobId).catch(() => null)
    if (!snap) return NextResponse.json({ error: "Job not found" }, { status: 404 })
    dir = snap.runDir ?? ""
    if (!dir) return NextResponse.json({ error: "This run has no log folder" }, { status: 404 })
  } else if (typeof body.toolId === "string" && getTool(body.toolId)) {
    dir = ensureDir(path.join(LOGS_DIR, safeName(body.toolId)))
  } else {
    return NextResponse.json({ error: "Say which run or tool" }, { status: 400 })
  }
  if (!isInsideApp(dir)) return NextResponse.json({ error: "That folder is outside the app's own folders" }, { status: 403 })
  try {
    openFolder(dir)
    return NextResponse.json({ path: dir })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 404 })
  }
}
