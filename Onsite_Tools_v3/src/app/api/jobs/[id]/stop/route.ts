import { NextResponse } from "next/server"
import { jobs } from "@/lib/jobs"

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return jobs.stop((await params).id)
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "Job is not running" }, { status: 404 })
}
