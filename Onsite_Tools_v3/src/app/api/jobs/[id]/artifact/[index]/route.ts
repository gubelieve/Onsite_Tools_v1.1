import fs from "node:fs"
import path from "node:path"
import { NextResponse } from "next/server"
import { jobs } from "@/lib/jobs"
import { isInsideApp } from "@/lib/paths"

const TYPES: Record<string, string> = {
  ".csv": "text/csv; charset=utf-8", ".json": "application/json", ".png": "image/png", ".log": "text/plain; charset=utf-8",
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; index: string }> }) {
  const { id, index } = await params
  const artifact = (await jobs.get(id))?.artifacts[Number(index)]
  // Only files this app wrote itself are served.
  if (!artifact || !isInsideApp(artifact.path) || !fs.existsSync(artifact.path)) {
    return NextResponse.json({ error: "File not found" }, { status: 404 })
  }
  return new NextResponse(new Uint8Array(fs.readFileSync(artifact.path)), {
    headers: {
      "Content-Type": TYPES[path.extname(artifact.path).toLowerCase()] ?? "application/octet-stream",
      "Content-Disposition": `attachment; filename="${artifact.name.replace(/"/g, "")}"`,
    },
  })
}
