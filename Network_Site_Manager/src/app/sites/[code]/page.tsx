import { Fragment } from "react"
import Link from "next/link"
import { notFound } from "next/navigation"
import { Badge } from "@astryxdesign/core/Badge"
import { DataTable, Td } from "@/components/data-table"
import { PageHeader, Panel } from "@/components/page-header"
import { getSite } from "@/lib/data"
import { DEVICE_STATUS, SITE_STATUS, formatSeen } from "@/lib/status"
import { ROLE_LABEL } from "@/lib/types"

export default async function SitePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const site = await getSite(decodeURIComponent(code))
  if (!site) notFound()

  const up = site.devices.filter((d) => d.status === "UP").length
  const info: [string, string][] = [
    ["Customer", site.customer],
    ["Region", site.region],
    ["Address", site.address ?? "—"],
    ["Contact", [site.contact, site.phone].filter(Boolean).join(" · ") || "—"],
  ]

  return (
    <>
      <div className="text-muted-foreground mb-1 text-xs"><Link href="/sites" className="hover:underline">All sites</Link> / {site.code}</div>
      <PageHeader
        title={`${site.code} · ${site.name}`}
        description={site.note ?? undefined}
        actions={<Badge variant={SITE_STATUS[site.status].variant} label={SITE_STATUS[site.status].label} />}
      />

      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
        <Panel title="Site information" className="mb-0">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            {info.map(([k, v]) => (<Fragment key={k}><dt className="text-muted-foreground">{k}</dt><dd>{v}</dd></Fragment>))}
          </dl>
        </Panel>
        <Panel title="Health" className="mb-0">
          <div className="text-3xl font-semibold tabular-nums">{up}/{site.devices.length}</div>
          <div className="text-muted-foreground text-xs">devices up</div>
          <div className="bg-muted mt-3 h-2 overflow-hidden rounded-full">
            <div className="bg-primary h-full" style={{ width: `${site.devices.length ? (up / site.devices.length) * 100 : 0}%` }} />
          </div>
        </Panel>
      </div>

      <Panel title={`Devices (${site.devices.length})`}>
        <DataTable head={["Hostname", "Mgmt IP", "Role", "Vendor / Model", "Serial", "OS", "Status", "Last seen"]} empty={site.devices.length === 0}>
          {site.devices.map((d) => (
            <tr key={d.id}>
              <Td><span className="font-medium">{d.hostname}</span></Td>
              <Td mono>{d.mgmtIp}</Td>
              <Td>{ROLE_LABEL[d.role]}</Td>
              <Td>{d.vendor} {d.model}</Td>
              <Td mono>{d.serial ?? "—"}</Td>
              <Td mono>{d.osVersion ?? "—"}</Td>
              <Td><Badge variant={DEVICE_STATUS[d.status].variant} label={DEVICE_STATUS[d.status].label} /></Td>
              <Td>{formatSeen(d.lastSeen)}</Td>
            </tr>
          ))}
        </DataTable>
      </Panel>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Panel title={`Subnets / VLANs (${site.subnets.length})`} className="mb-0">
          <DataTable head={["VLAN", "Name", "CIDR", "Gateway"]} empty={site.subnets.length === 0}>
            {site.subnets.map((n) => (
              <tr key={n.id}>
                <Td>{n.vlan ?? "—"}</Td>
                <Td>{n.name}</Td>
                <Td mono>{n.cidr}</Td>
                <Td mono>{n.gateway ?? "—"}</Td>
              </tr>
            ))}
          </DataTable>
        </Panel>
        <Panel title={`WAN circuits (${site.circuits.length})`} className="mb-0">
          <DataTable head={["Provider", "Circuit ID", "Type", "Bandwidth", "Status"]} empty={site.circuits.length === 0}>
            {site.circuits.map((c) => (
              <tr key={c.id}>
                <Td>{c.provider}</Td>
                <Td mono>{c.circuitId}</Td>
                <Td>{c.type}</Td>
                <Td>{c.bandwidth}</Td>
                <Td><Badge variant={DEVICE_STATUS[c.status].variant} label={DEVICE_STATUS[c.status].label} /></Td>
              </tr>
            ))}
          </DataTable>
        </Panel>
      </div>
    </>
  )
}
