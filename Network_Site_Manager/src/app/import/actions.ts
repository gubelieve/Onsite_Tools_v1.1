"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { parseConfig } from "@/lib/config-parser"
import { deleteConfig, saveConfig } from "@/lib/config-store"
import { findSite } from "@/lib/data"

// No login exists yet (the whole app is open, see README), so there is no
// identity to check here. When auth arrives, check it at the top of both
// actions: a Server Action is reachable by a direct POST, not only from the page.

const MAX_FILE = 2 * 1024 * 1024
const MAX_FILES = 50

const ImportInput = z.object({
  siteCode: z.string().min(1).max(40),
  items: z.array(z.object({
    fileName: z.string().min(1).max(200),
    raw: z.string().min(1).max(MAX_FILE),
    hostname: z.string().max(120).optional(),
  })).min(1).max(MAX_FILES),
})

export interface ImportResult {
  ok: boolean
  error?: string
  saved: { fileName: string; hostname: string }[]
  skipped: { fileName: string; reason: string }[]
}

export async function importConfigs(input: z.infer<typeof ImportInput>): Promise<ImportResult> {
  const parsed = ImportInput.safeParse(input)
  if (!parsed.success) return { ok: false, error: "ข้อมูลที่ส่งมาไม่ถูกต้อง (ไฟล์ละไม่เกิน 2 MB, ครั้งละไม่เกิน 50 ไฟล์)", saved: [], skipped: [] }
  const site = await findSite(parsed.data.siteCode)
  if (!site) return { ok: false, error: "ไม่พบ Site นี้", saved: [], skipped: [] }

  const result: ImportResult = { ok: true, saved: [], skipped: [] }
  const importedAt = new Date().toISOString()
  for (const item of parsed.data.items) {
    // Parsed again here rather than trusting the browser's preview.
    const cfg = parseConfig(item.raw)
    const hostname = (cfg.hostname ?? item.hostname ?? "").trim()
    if (!hostname) {
      result.skipped.push({ fileName: item.fileName, reason: "ไม่พบ hostname ใน config และไม่ได้ระบุเอง" })
      continue
    }
    if (cfg.interfaces.length === 0) {
      result.skipped.push({ fileName: item.fileName, reason: "ไม่พบ interface ใน config (อาจไม่ใช่ไฟล์ running-config)" })
      continue
    }
    await saveConfig({ siteCode: site.code, hostname, fileName: item.fileName, importedAt, raw: item.raw })
    result.saved.push({ fileName: item.fileName, hostname })
  }
  revalidatePath("/", "layout")
  return result
}

export async function removeConfig(siteCode: string, hostname: string): Promise<{ ok: boolean }> {
  const site = await findSite(String(siteCode))
  if (!site || typeof hostname !== "string" || !hostname) return { ok: false }
  await deleteConfig(site.code, hostname)
  revalidatePath("/", "layout")
  return { ok: true }
}
