import { NextResponse } from "next/server"
import { jobs } from "@/lib/jobs"

export const dynamic = "force-dynamic"

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  // The browser polls once a second while a job runs. A run of Config Devices or Compare Configuration
  // carries every command's output in its rows, so re-sending an unchanged snapshot every second moves
  // megabytes for nothing. `version` only moves when something actually happened.
  const since = Number(new URL(req.url).searchParams.get("version"))
  if (Number.isFinite(since)) {
    const current = jobs.versionOf(id)
    if (current !== null && current === since) return NextResponse.json({ id, version: current, unchanged: true })
  }
  const snap = await jobs.get(id)
  return snap ? NextResponse.json(snap) : NextResponse.json({ error: "Job not found" }, { status: 404 })
}
