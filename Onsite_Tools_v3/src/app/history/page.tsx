import Link from "next/link"
import { Badge } from "@astryxdesign/core/Badge"
import { PageHeader, Panel } from "@/components/page-header"
import prisma from "@/lib/prisma"

const VARIANT: Record<string, "green" | "red" | "yellow" | "neutral"> = { done: "green", error: "red", stopped: "red", running: "yellow" }
const th = "bg-muted sticky top-0 border-b px-3 py-2 text-left font-semibold whitespace-nowrap"
const td = "max-w-[420px] truncate px-3 py-2 whitespace-nowrap"

export default async function HistoryPage() {
  const runs = await prisma.jobRun.findMany({
    orderBy: { createdAt: "desc" }, take: 300,
    select: { id: true, toolName: true, runLabel: true, status: true, summary: true, rowCount: true, createdAt: true, finishedAt: true, runDir: true },
  })
  return (
    <>
      <PageHeader title="Run History" description="Every finished run is saved in the local database with its full results. Credentials are never stored." />
      <Panel>
        {runs.length === 0 ? <p className="text-muted-foreground text-sm">No runs yet.</p> : (
          <div className="max-h-[75vh] overflow-auto rounded-xl border">
            <table className="w-full border-collapse text-[13px]">
              <thead><tr>{["Started", "Tool", "Run", "Status", "Rows", "Summary", "Log folder"].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="hover:bg-muted/50 border-b last:border-0">
                    <td className={td}><Link className="text-primary underline" href={`/history/${r.id}`}>{r.createdAt.toLocaleString("sv-SE")}</Link></td>
                    <td className={td}>{r.toolName}</td>
                    <td className={td}>{r.runLabel}</td>
                    <td className={td}><Badge variant={VARIANT[r.status] ?? "neutral"} label={r.status} /></td>
                    <td className={`${td} tabular-nums`}>{r.rowCount}</td>
                    <td className={td} title={r.summary}>{r.summary}</td>
                    <td className={`${td} font-mono text-xs`} title={r.runDir}>{r.runDir}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  )
}
