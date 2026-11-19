import Link from "next/link"
import { Badge } from "@astryxdesign/core/Badge"
import { PageHeader, Panel } from "@/components/page-header"
import { listDevices, listSites } from "@/lib/data"
import { DEVICE_STATUS, SITE_STATUS } from "@/lib/status"

export default async function Dashboard() {
  const [sites, devices] = await Promise.all([listSites(), listDevices()])
  const problems = devices.filter((d) => d.status === "DOWN" || d.status === "WARNING")
  const stats = [
    { label: "Sites", value: sites.length, href: "/sites" },
    { label: "Sites with issues", value: sites.filter((s) => s.status !== "ONLINE").length, href: "/sites" },
    { label: "Devices", value: devices.length, href: "/devices" },
    { label: "Devices down / warning", value: problems.length, href: "/devices" },
  ]

  return (
    <>
      <PageHeader title="Dashboard" description="ภาพรวม Network ของทุก Site: สถานะ Site, อุปกรณ์ที่มีปัญหา และทางลัดไปยังรายละเอียดของแต่ละ Site" />
      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stats.map((s) => (
          <Link key={s.label} href={s.href} className="bg-card block p-5 transition hover:opacity-90">
            <div className="text-muted-foreground text-xs">{s.label}</div>
            <div className="mt-1 text-3xl font-semibold tabular-nums">{s.value}</div>
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[3fr_2fr]">
        <Panel title="Sites" className="mb-0" actions={<Link className="text-primary text-xs underline" href="/sites">All sites</Link>}>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {sites.map((s) => (
              <Link key={s.code} href={`/sites/${s.code}`} className="border-border hover:bg-muted block rounded-[var(--corner-card)] border p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-sm font-semibold">{s.code}</span>
                  <Badge variant={SITE_STATUS[s.status].variant} label={SITE_STATUS[s.status].label} />
                </div>
                <div className="mt-1 truncate text-sm">{s.name}</div>
                <div className="text-muted-foreground mt-1 text-xs">
                  {s.customer} · {s.region} · {s.deviceCount} devices
                  {s.devicesDown > 0 && <span className="text-destructive"> · {s.devicesDown} down</span>}
                </div>
              </Link>
            ))}
          </div>
        </Panel>

        <Panel title="Devices needing attention" className="mb-0">
          {problems.length === 0 ? <p className="text-muted-foreground text-sm">ทุกอุปกรณ์ทำงานปกติ</p> : (
            <ul className="divide-border divide-y">
              {problems.map((d) => (
                <li key={d.id} className="flex items-center gap-3 py-2">
                  <Badge variant={DEVICE_STATUS[d.status].variant} label={DEVICE_STATUS[d.status].label} />
                  <Link href={`/sites/${d.siteCode}`} className="min-w-0 flex-1 hover:underline">
                    <span className="block truncate text-sm font-medium">{d.hostname}</span>
                    <span className="text-muted-foreground block truncate text-xs">{d.siteCode} · {d.mgmtIp} · {d.model}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  )
}
