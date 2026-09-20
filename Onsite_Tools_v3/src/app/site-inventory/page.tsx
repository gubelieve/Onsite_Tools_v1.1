import { PageHeader } from "@/components/page-header"
import { DEVICE_TYPES } from "@/lib/net/ssh"
import { summary } from "@/lib/inventory"
import { InventoryClient } from "./inventory-client"

export default async function SiteInventoryPage() {
  const data = await summary()
  return (
    <>
      <PageHeader
        title="Site Inventory"
        description="Import device lists once (CSV / XLSX). They are stored in the local database on this PC and every device tool picks its devices from here by list and device category."
      />
      <InventoryClient
        deviceTypes={[...DEVICE_TYPES]}
        summary={{ ...data, imports: data.imports.map((i) => ({ ...i, importedAt: i.importedAt.toLocaleString("sv-SE") })) }}
      />
    </>
  )
}
