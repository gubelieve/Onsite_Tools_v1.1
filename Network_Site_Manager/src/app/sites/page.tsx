import { PageHeader, Panel } from "@/components/page-header"
import { listSites } from "@/lib/data"
import { SitesTable } from "./sites-table"

export default async function SitesPage() {
  const sites = await listSites()
  return (
    <>
      <PageHeader title="All sites" description="รายชื่อ Site ทั้งหมดที่ดูแล ค้นหาด้วยรหัส ชื่อ ลูกค้า หรือภูมิภาค แล้วคลิกเพื่อดูอุปกรณ์ Subnet และวงจร WAN ของ Site นั้น" />
      <Panel>
        <SitesTable sites={sites} />
      </Panel>
    </>
  )
}
