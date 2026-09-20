import { NextResponse } from "next/server"
import { toCsv } from "@/lib/csv"
import { exportRows } from "@/lib/inventory"
import { safeName, stamp } from "@/lib/paths"

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams
  const { columns, rows } = await exportRows(q.get("list"), q.get("site"))
  return new NextResponse(toCsv(columns, rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="site_inventory_${safeName(q.get("list") || "all")}_${stamp()}.csv"`,
    },
  })
}
