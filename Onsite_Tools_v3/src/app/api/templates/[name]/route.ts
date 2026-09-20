import fs from "node:fs"
import path from "node:path"
import { NextResponse } from "next/server"
import { TEMPLATES_DIR } from "@/lib/paths"

export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const name = path.basename((await params).name)
  const file = path.join(TEMPLATES_DIR, name)
  if (!fs.existsSync(file)) return NextResponse.json({ error: "Template not found" }, { status: 404 })
  return new NextResponse(new Uint8Array(fs.readFileSync(file)), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"` },
  })
}
