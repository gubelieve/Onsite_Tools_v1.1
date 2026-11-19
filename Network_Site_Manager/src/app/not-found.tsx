import Link from "next/link"
import { PageHeader } from "@/components/page-header"

export default function NotFound() {
  return (
    <>
      <PageHeader title="Not found" description="ไม่พบหน้าหรือ Site ที่ต้องการ" />
      <Link href="/sites" className="text-primary text-sm underline">Back to all sites</Link>
    </>
  )
}
