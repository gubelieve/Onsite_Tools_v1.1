import { NextResponse } from "next/server"
import { countDevices, listNames, sitesOf } from "@/lib/inventory"

export const dynamic = "force-dynamic"

/** Everything a tool form needs for its "Device list" + "Site" selectors in one call. */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams
  const list = q.get("list"), site = q.get("site")
  const [lists, sites, count] = await Promise.all([listNames(), sitesOf(list), countDevices(list, site)])
  return NextResponse.json({ lists, sites, count })
}
