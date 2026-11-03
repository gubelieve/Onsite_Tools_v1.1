import { NextResponse } from "next/server"
import { listTemplates } from "@/lib/command-templates"

export const dynamic = "force-dynamic"

/** The saved templates, for the "Load template" picker in the tool forms. */
export async function GET() {
  return NextResponse.json({ templates: await listTemplates() })
}
