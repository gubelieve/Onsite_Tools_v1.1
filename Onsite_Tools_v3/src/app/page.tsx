import Link from "next/link"
import { Badge } from "@astryxdesign/core/Badge"
import { PageHeader, Panel } from "@/components/page-header"
import { summary } from "@/lib/inventory"
import { BASE_DIR, DATA_DIR, LOGS_DIR } from "@/lib/paths"
import prisma from "@/lib/prisma"
import { TOOLS } from "@/lib/tools"

const VARIANT: Record<string, "green" | "red" | "yellow" | "neutral"> = { done: "green", error: "red", stopped: "red", running: "yellow" }

export default async function Dashboard() {
  const [inv, runs, runCount] = await Promise.all([
    summary(),
    prisma.jobRun.findMany({ orderBy: { createdAt: "desc" }, take: 8 }),
    prisma.jobRun.count(),
  ])
  const groups = new Map<string, typeof TOOLS>()
  for (const t of TOOLS) groups.set(t.category, [...(groups.get(t.category) ?? []), t])
  const stats = [
    { label: "Devices in Site Inventory", value: inv.total.toLocaleString(), href: "/site-inventory" },
    { label: "Device lists", value: inv.lists.length, href: "/site-inventory" },
    { label: "Sites", value: inv.sites.length, href: "/site-inventory" },
    { label: "Saved runs", value: runCount.toLocaleString(), href: "/history" },
  ]

  return (
    <>
      <PageHeader title="Dashboard" description="Import your device lists in Site Inventory once, then run any tool against a list and site. Everything runs and is stored on this PC." />
      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stats.map((s) => (
          <Link key={s.label} href={s.href} className="bg-card block p-5 transition hover:opacity-90">
            <div className="text-muted-foreground text-xs">{s.label}</div>
            <div className="mt-1 text-3xl font-semibold tabular-nums">{s.value}</div>
          </Link>
        ))}
      </div>

      {inv.total === 0 && (
        <Panel title="Start here">
          <p className="text-sm">Site Inventory is empty. <Link className="text-primary underline" href="/site-inventory">Import a device list</Link> (CSV or XLSX) before running a device tool.</p>
        </Panel>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Panel title="Tools" className="mb-0">
          {[...groups].map(([group, tools]) => (
            <div key={group} className="mb-3 last:mb-0">
              <div className="text-muted-foreground mb-1 text-xs font-semibold tracking-wide uppercase">{group}</div>
              <ul className="space-y-1">
                {tools.map((t) => (
                  <li key={t.id}>
                    <Link href={`/tools/${t.id}`} className="hover:bg-muted block rounded-lg px-2 py-1.5">
                      <span className="text-sm font-medium">{t.name}</span>
                      <span className="text-muted-foreground block truncate text-xs">{t.description}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </Panel>

        <div>
          <Panel title="Recent runs" actions={<Link className="text-primary text-xs underline" href="/history">All runs</Link>}>
            {runs.length === 0 ? <p className="text-muted-foreground text-sm">No runs yet.</p> : (
              <ul className="divide-y">
                {runs.map((r) => (
                  <li key={r.id} className="flex items-center gap-3 py-2">
                    <Badge variant={VARIANT[r.status] ?? "neutral"} label={r.status} />
                    <Link href={`/history/${r.id}`} className="min-w-0 flex-1 hover:underline">
                      <span className="block truncate text-sm font-medium">{r.toolName} · {r.runLabel}</span>
                      <span className="text-muted-foreground block truncate text-xs">{r.createdAt.toLocaleString("sv-SE")} · {r.rowCount} rows{r.summary ? ` · ${r.summary}` : ""}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="Where things are stored" className="mb-0">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
              <dt className="text-muted-foreground">App folder</dt><dd className="font-mono break-all">{BASE_DIR}</dd>
              <dt className="text-muted-foreground">Database</dt><dd className="font-mono break-all">{DATA_DIR}\onsite.db (SQLite)</dd>
              <dt className="text-muted-foreground">Device logs</dt><dd className="font-mono break-all">{LOGS_DIR}</dd>
            </dl>
          </Panel>
        </div>
      </div>
    </>
  )
}
