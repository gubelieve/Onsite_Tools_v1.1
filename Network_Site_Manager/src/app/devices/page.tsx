import Link from "next/link"
import { Badge } from "@astryxdesign/core/Badge"
import { DataTable, Td } from "@/components/data-table"
import { PageHeader, Panel } from "@/components/page-header"
import { listDevices } from "@/lib/data"
import { DEVICE_STATUS, formatSeen } from "@/lib/status"
import { ROLE_LABEL } from "@/lib/types"

export default async function DevicesPage() {
  const devices = await listDevices()
  return (
    <>
      <PageHeader title="All devices" description="อุปกรณ์ Network ทุกตัวจากทุก Site" />
      <Panel>
        <DataTable head={["Site", "Hostname", "Mgmt IP", "Role", "Vendor / Model", "OS", "Status", "Last seen"]} empty={devices.length === 0}>
          {devices.map((d) => (
            <tr key={d.id}>
              <Td mono><Link href={`/sites/${d.siteCode}`} className="text-primary hover:underline">{d.siteCode}</Link></Td>
              <Td><span className="font-medium">{d.hostname}</span></Td>
              <Td mono>{d.mgmtIp}</Td>
              <Td>{ROLE_LABEL[d.role]}</Td>
              <Td>{d.vendor} {d.model}</Td>
              <Td mono>{d.osVersion ?? "—"}</Td>
              <Td><Badge variant={DEVICE_STATUS[d.status].variant} label={DEVICE_STATUS[d.status].label} /></Td>
              <Td>{formatSeen(d.lastSeen)}</Td>
            </tr>
          ))}
        </DataTable>
      </Panel>
    </>
  )
}
