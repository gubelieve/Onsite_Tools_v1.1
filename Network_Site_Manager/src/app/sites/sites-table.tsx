"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { Badge } from "@astryxdesign/core/Badge"
import { DataTable, Td } from "@/components/data-table"
import { SITE_STATUS } from "@/lib/status"
import type { SiteStatus, SiteSummary } from "@/lib/types"

const FILTERS: (SiteStatus | "ALL")[] = ["ALL", "ONLINE", "DEGRADED", "OFFLINE"]

export function SitesTable({ sites }: { sites: SiteSummary[] }) {
  const [q, setQ] = useState("")
  const [status, setStatus] = useState<SiteStatus | "ALL">("ALL")
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return sites.filter((s) =>
      (status === "ALL" || s.status === status) &&
      (!needle || [s.code, s.name, s.customer, s.region].some((v) => v.toLowerCase().includes(needle))),
    )
  }, [sites, q, status])

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search code, name, customer, region"
          aria-label="Search sites"
          className="border-border bg-background focus:ring-ring h-9 w-full max-w-sm rounded-[var(--corner-control)] border px-3 text-sm outline-none focus:ring-2"
        />
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setStatus(f)}
              aria-pressed={status === f}
              className={`h-8 rounded-full px-3 text-xs ${status === f ? "bg-primary text-primary-foreground" : "bg-muted hover:opacity-80"}`}
            >
              {f === "ALL" ? "All" : SITE_STATUS[f].label}
            </button>
          ))}
        </div>
        <span className="text-muted-foreground ml-auto text-xs">{rows.length} of {sites.length}</span>
      </div>
      <DataTable head={["Code", "Name", "Customer", "Region", "Status", "Devices", "Down", "Contact"]} empty={rows.length === 0}>
        {rows.map((s) => (
          <tr key={s.code} className="hover:bg-muted/60">
            <Td mono><Link href={`/sites/${s.code}`} className="text-primary font-semibold hover:underline">{s.code}</Link></Td>
            <Td>{s.name}</Td>
            <Td>{s.customer}</Td>
            <Td>{s.region}</Td>
            <Td><Badge variant={SITE_STATUS[s.status].variant} label={SITE_STATUS[s.status].label} /></Td>
            <Td>{s.deviceCount}</Td>
            <Td>{s.devicesDown > 0 ? <span className="text-destructive font-medium">{s.devicesDown}</span> : 0}</Td>
            <Td>{s.contact ?? "—"}{s.phone ? ` · ${s.phone}` : ""}</Td>
          </tr>
        ))}
      </DataTable>
    </>
  )
}
