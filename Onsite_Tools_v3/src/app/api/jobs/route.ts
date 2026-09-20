import { NextResponse } from "next/server"
import { jobs } from "@/lib/jobs"
import prisma from "@/lib/prisma"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const toolId = new URL(req.url).searchParams.get("tool") ?? undefined
  const saved = await prisma.jobRun.findMany({
    where: toolId ? { toolId } : {}, orderBy: { createdAt: "desc" }, take: 50,
    select: { id: true, toolId: true, toolName: true, runLabel: true, status: true, summary: true, rowCount: true, createdAt: true },
  })
  return NextResponse.json({
    running: jobs.running(toolId),
    history: saved.map((j) => ({ ...j, created: j.createdAt.toLocaleString("sv-SE") })),
  })
}
