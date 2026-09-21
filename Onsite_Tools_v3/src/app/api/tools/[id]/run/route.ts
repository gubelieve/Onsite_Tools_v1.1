import { NextResponse } from "next/server"
import { jobs } from "@/lib/jobs"
import { getTool } from "@/lib/tools"
import type { FieldDef, Params } from "@/lib/tools/types"

const visible = (f: FieldDef, p: Params) => !f.showIf || Object.entries(f.showIf).every(([k, v]) => String(p[k] ?? "") === v)
const empty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const tool = getTool((await params).id)
  if (!tool) return NextResponse.json({ error: "Unknown tool" }, { status: 404 })
  const body = (await req.json().catch(() => ({}))) as { params?: Params; runId?: string }
  const runDef = tool.runs.find((r) => r.id === body.runId) ?? tool.runs[0]
  const p: Params = { ...(body.params ?? {}), ...(runDef.params ?? {}) }
  const missing = tool.fields
    .filter((f) => f.required && !runDef.optionalFields?.includes(f.name) && visible(f, p) && empty(p[f.name]))
    .map((f) => f.label)
  if (missing.length) return NextResponse.json({ error: `Please fill in: ${missing.join(", ")}` }, { status: 400 })
  return NextResponse.json({ jobId: jobs.start(tool, p, runDef.label) })
}
