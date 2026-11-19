import { PageHeader } from "@/components/page-header"
import { findSite, getSiteTopology, listSites } from "@/lib/data"
import { DiagramClient } from "./diagram-client"

export default async function DiagramPage({ searchParams }: { searchParams: Promise<{ site?: string }> }) {
  const { site: wanted } = await searchParams
  const sites = await listSites()
  // Default to the first site that has configs, so the page opens on something to look at.
  const site = (wanted && (await findSite(wanted))) || sites.find((s) => s.configCount > 0) || sites[0]
  const data = await getSiteTopology(site.code)

  return (
    <>
      <PageHeader
        title="Diagram"
        description="Network diagram ของ Site ที่สร้างจาก config ที่ Import มา เส้นเชื่อมได้จาก IP วง /30–/31 ที่ตรงกัน และจาก description ของ interface ที่ระบุชื่ออุปกรณ์ปลายทาง ลากอุปกรณ์เพื่อจัดตำแหน่ง ใช้ล้อเมาส์เพื่อซูม"
      />
      <DiagramClient
        key={site.code}
        sites={sites.map((s) => ({ code: s.code, name: s.name, configCount: s.configCount }))}
        siteCode={site.code}
        topology={data!.topology}
        configCount={data!.configCount}
      />
    </>
  )
}
