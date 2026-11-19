import { PageHeader } from "@/components/page-header"
import { listConfigs } from "@/lib/config-store"
import { findSite, getSite, listSites } from "@/lib/data"
import { ImportClient } from "./import-client"

export default async function ImportPage({ searchParams }: { searchParams: Promise<{ site?: string }> }) {
  const { site: wanted } = await searchParams
  const sites = await listSites()
  const site = (wanted && (await findSite(wanted))) || sites[0]
  const [stored, detail] = await Promise.all([listConfigs(site.code), getSite(site.code)])

  return (
    <>
      <PageHeader
        title="Import configuration"
        description="อัปโหลดไฟล์ running-config (show running-config) ของอุปกรณ์ใน Site เพื่ออัปเดตข้อมูลอุปกรณ์และ Subnet/VLAN และใช้สร้าง Diagram รองรับรูปแบบ Cisco IOS / IOS-XE / NX-OS และ Aruba AOS-CX"
      />
      <ImportClient
        key={site.code}
        sites={sites.map((s) => ({ code: s.code, name: s.name }))}
        siteCode={site.code}
        deviceHostnames={detail?.devices.map((d) => d.hostname) ?? []}
        stored={stored.map((c) => ({ hostname: c.hostname, fileName: c.fileName, importedAt: c.importedAt, size: c.raw.length }))}
      />
    </>
  )
}
