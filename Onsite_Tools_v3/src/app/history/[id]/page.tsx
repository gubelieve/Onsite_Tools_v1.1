import Link from "next/link"
import { notFound } from "next/navigation"
import { JobPanel } from "@/components/job-panel"
import { PageHeader, Panel } from "@/components/page-header"
import { jobs } from "@/lib/jobs"

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const snap = await jobs.get(id)
  if (!snap) notFound()
  return (
    <>
      <PageHeader
        title={`${snap.toolName} · ${snap.runLabel}`}
        description={<>Started {snap.created}. <Link className="text-primary underline" href={`/tools/${snap.toolId}`}>Open the tool</Link> · <Link className="text-primary underline" href="/history">All runs</Link></>}
      />
      <Panel><JobPanel key={id} jobId={id} /></Panel>
    </>
  )
}
