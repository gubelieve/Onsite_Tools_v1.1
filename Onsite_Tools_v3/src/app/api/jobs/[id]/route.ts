import { NextResponse } from "next/server"
import { jobs } from "@/lib/jobs"

export const dynamic = "force-dynamic"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const snap = await jobs.get((await params).id)
  return snap ? NextResponse.json(snap) : NextResponse.json({ error: "Job not found" }, { status: 404 })
}
