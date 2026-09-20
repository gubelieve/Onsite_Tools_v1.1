import { NextResponse } from "next/server"
import { listDevices } from "@/lib/inventory"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams
  const page = Math.max(0, Number(q.get("page")) || 0)
  const size = Math.min(500, Math.max(10, Number(q.get("size")) || 100))
  return NextResponse.json(await listDevices(q.get("list"), q.get("site"), q.get("q"), size, page * size))
}
