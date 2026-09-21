/** The run session of a tool: GET = what is open now, DELETE = Done (the next run starts a new folder). */
import { NextResponse } from "next/server"
import { endSession, sessionInfo } from "@/lib/session"
import { getTool } from "@/lib/tools"

async function toolId(params: Promise<{ toolId: string }>) {
  const { toolId } = await params
  return getTool(toolId)?.id ?? null
}

export async function GET(_req: Request, { params }: { params: Promise<{ toolId: string }> }) {
  const id = await toolId(params)
  if (!id) return NextResponse.json({ error: "Unknown tool" }, { status: 404 })
  return NextResponse.json(sessionInfo(id))
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ toolId: string }> }) {
  const id = await toolId(params)
  if (!id) return NextResponse.json({ error: "Unknown tool" }, { status: 404 })
  const closed = endSession(id)
  return NextResponse.json({ closed: Boolean(closed), dir: closed?.dir ?? "" })
}
