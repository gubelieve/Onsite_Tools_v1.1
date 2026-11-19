import type { ReactNode } from "react"

/** A plain, scrollable table styled to sit inside a Panel. */
export function DataTable({ head, children, empty }: { head: ReactNode[]; children: ReactNode; empty?: boolean }) {
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead>
          <tr className="text-muted-foreground border-border border-b text-xs">
            {head.map((h, i) => <th key={i} className="px-2 py-2 font-medium whitespace-nowrap">{h}</th>)}
          </tr>
        </thead>
        <tbody className="divide-border divide-y">
          {empty ? <tr><td colSpan={head.length} className="text-muted-foreground px-2 py-6 text-center">No rows</td></tr> : children}
        </tbody>
      </table>
    </div>
  )
}

export function Td({ children, mono = false }: { children: ReactNode; mono?: boolean }) {
  return <td className={`px-2 py-2 whitespace-nowrap ${mono ? "font-mono text-xs" : ""}`}>{children}</td>
}
