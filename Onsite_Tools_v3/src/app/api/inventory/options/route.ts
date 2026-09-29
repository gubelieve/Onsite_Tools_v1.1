import { NextResponse } from "next/server"
import { countDevices, listNames, previewDevices, sitesOf } from "@/lib/inventory"

export const dynamic = "force-dynamic"

/** At most this many devices travel to the form; the count is always the real one. */
const PREVIEW = 300

/** Everything a tool form needs for its "Device list" + "Device Category" selectors in one call,
 *  including which devices the selection covers. */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams
  // Repeated params, because the pickers are multi-select: ?list=LAB&list=arise&site=SS&site=FB
  const list = q.getAll("list"), site = q.getAll("site")
  const [lists, sites, count, devices] = await Promise.all([
    listNames(), sitesOf(list), countDevices(list, site), previewDevices(list, site, PREVIEW),
  ])
  return NextResponse.json({ lists, sites, count, devices })
}
