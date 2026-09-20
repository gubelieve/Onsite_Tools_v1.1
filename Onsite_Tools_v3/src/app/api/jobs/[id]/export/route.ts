import { NextResponse } from "next/server"
import { toCsv } from "@/lib/csv"
import { jobs } from "@/lib/jobs"
import { stamp } from "@/lib/paths"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const snap = await jobs.get((await params).id)
  if (!snap) return NextResponse.json({ error: "Job not found" }, { status: 404 })
  const columns = snap.exportColumns ?? snap.columns
  return new NextResponse(toCsv(columns, snap.rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${snap.toolId}_${stamp()}.csv"`,
    },
  })
}
