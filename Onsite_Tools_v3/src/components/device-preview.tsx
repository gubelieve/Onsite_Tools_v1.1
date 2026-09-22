"use client"

import * as React from "react"
import Link from "next/link"
import { ChevronDown, ChevronRight } from "lucide-react"
import { Button } from "@astryxdesign/core/Button"
import { TextInput } from "@astryxdesign/core/TextInput"

export interface PreviewDevice { ip: string; hostname: string; site: string; deviceType: string; model: string; description: string; list: string }

/** Open/closed is remembered per browser - some people want the list up, some want the form short. */
const KEY = "onsite:showDevices"
const COLUMNS: [string, keyof PreviewDevice][] = [
  ["IP Address", "ip"], ["Hostname", "hostname"], ["Device Category", "site"], ["Device type", "deviceType"],
  ["Model", "model"], ["Description", "description"], ["Device list", "list"],
]

/**
 * The devices the current "Device list" + "Device Category" selection covers - exactly the ones a run
 * would contact, in the same order and with the same de-duplication by IP.
 */
export function DevicePreview({ devices, count }: { devices: PreviewDevice[]; count: number }) {
  const [open, setOpen] = React.useState(true)
  const [filter, setFilter] = React.useState("")

  React.useEffect(() => {
    // localStorage only exists in the browser, so this runs after hydration.
    const timer = setTimeout(() => {
      try { const saved = localStorage.getItem(KEY); if (saved !== null) setOpen(saved === "1") } catch { /* private mode */ }
    }, 0)
    return () => clearTimeout(timer)
  }, [])

  const toggle = () => setOpen((wasOpen) => {
    try { localStorage.setItem(KEY, wasOpen ? "0" : "1") } catch { /* private mode */ }
    return !wasOpen
  })

  const shown = React.useMemo(() => {
    const f = filter.trim().toLowerCase()
    return f ? devices.filter((d) => Object.values(d).some((v) => String(v ?? "").toLowerCase().includes(f))) : devices
  }, [devices, filter])

  if (count === 0) {
    return (
      <p className="text-destructive mt-1 text-sm">
        No device matches this selection — import a list in <Link className="underline" href="/site-inventory">Site Inventory</Link>.
      </p>
    )
  }

  return (
    <div className="bg-muted/30 mt-1 rounded-xl border">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <Button variant="ghost" size="sm" label={open ? "Hide devices" : "Show devices"}
          icon={open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />} onClick={toggle} />
        <span className="text-sm"><b>{count.toLocaleString()}</b> device(s) will be used</span>
        {devices.length < count && <span className="text-muted-foreground text-xs">(first {devices.length} listed)</span>}
        <span className="flex-1" />
        {open && devices.length > 8 && (
          <div className="w-56">
            <TextInput label="Filter devices" isLabelHidden placeholder="Filter devices…" value={filter} onChange={setFilter} hasClear size="sm" />
          </div>
        )}
        <Link className="text-muted-foreground text-xs underline" href="/site-inventory">Edit in Site Inventory</Link>
      </div>

      {open && (
        <div className="result-table max-h-64 overflow-auto border-t">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>{COLUMNS.map(([label]) => (
                <th key={label} className="bg-muted sticky top-0 z-[1] border-b px-3 py-1.5 text-left font-semibold whitespace-nowrap">{label}</th>
              ))}</tr>
            </thead>
            <tbody>
              {shown.map((d) => (
                <tr key={`${d.list}/${d.ip}`} className="hover:bg-muted/50 border-b last:border-0">
                  {COLUMNS.map(([label, key]) => (
                    <td key={label} className="max-w-[260px] truncate px-3 py-1 align-top whitespace-nowrap" title={d[key]}>
                      {d[key] || <span className="text-muted-foreground">—</span>}
                    </td>
                  ))}
                </tr>
              ))}
              {shown.length === 0 && (
                <tr><td className="text-muted-foreground px-3 py-2" colSpan={COLUMNS.length}>No device matches “{filter}”.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
