import { notFound } from "next/navigation"
import { PageHeader } from "@/components/page-header"
import { ToolRunner } from "@/components/tool-runner"
import { DEVICE_TYPES } from "@/lib/net/ssh"
import { getSettings, localIp } from "@/lib/settings"
import { getTool, publicTool } from "@/lib/tools"

export default async function ToolPage({ params }: { params: Promise<{ id: string }> }) {
  const tool = getTool((await params).id)
  if (!tool) notFound()
  const s = await getSettings()
  return (
    <>
      <PageHeader title={tool.name} description={tool.description} />
      <ToolRunner
        key={tool.id}
        tool={publicTool(tool)}
        deviceTypes={[...DEVICE_TYPES]}
        defaults={{ username: s.username, deviceType: s.deviceType, threads: s.threads, snmpCommunity: s.snmpCommunity, localIp: localIp() }}
      />
    </>
  )
}
