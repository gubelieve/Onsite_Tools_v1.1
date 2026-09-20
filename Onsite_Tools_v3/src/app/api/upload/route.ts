import fs from "node:fs"
import path from "node:path"
import { NextResponse } from "next/server"
import { UPLOADS_DIR, ensureDir, safeName, stamp } from "@/lib/paths"

export async function POST(req: Request) {
  const form = await req.formData()
  const files = form.getAll("files").filter((f): f is File => f instanceof File)
  if (!files.length) return NextResponse.json({ error: "No file received" }, { status: 400 })
  ensureDir(UPLOADS_DIR)
  const out = []
  for (const [i, f] of files.entries()) {
    const target = path.join(UPLOADS_DIR, `${stamp()}_${i}_${safeName(f.name)}`)
    fs.writeFileSync(target, Buffer.from(await f.arrayBuffer()))
    out.push({ name: f.name, path: target, size: f.size })
  }
  return NextResponse.json(out)
}
