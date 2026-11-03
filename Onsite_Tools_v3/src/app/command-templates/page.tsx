import { PageHeader } from "@/components/page-header"
import { listTemplates } from "@/lib/command-templates"
import { sitesOf } from "@/lib/inventory"
import { TemplatesClient } from "./templates-client"

export const dynamic = "force-dynamic"

export default async function CommandTemplatesPage() {
  const [templates, categories] = await Promise.all([listTemplates(), sitesOf().catch(() => [])])
  return (
    <>
      <PageHeader
        title="Command Templates"
        description="Save the commands you run for each Device Category once, then load them into Config Devices (or the IOS Upgrade capture) with one pick. Stored in the local database on this PC."
      />
      <TemplatesClient initial={templates} categories={categories} />
    </>
  )
}
