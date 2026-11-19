import "server-only"
import { promises as fs } from "node:fs"
import path from "node:path"

// Imported configs, one JSON file per device:
//   <DATA_DIR>/configs/<SITE-CODE>/<hostname>.json
//
// Files, not the database, because the database is not provisioned yet; the
// matching Prisma model (DeviceConfig) is already in schema.prisma, so moving
// this to Postgres touches this file only. Only the RAW text is stored and it
// is parsed on every read, so a parser fix applies to configs imported earlier.

export interface StoredConfig {
  siteCode: string
  hostname: string
  fileName: string
  importedAt: string
  raw: string
}

export const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data")
const CONFIG_DIR = path.join(DATA_DIR, "configs")

/** A name that is safe as one path segment. Anything else becomes "_". */
export function safeSegment(name: string): string {
  const s = name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_")
  return s.slice(0, 120) || "_"
}

function siteDir(siteCode: string) {
  return path.join(CONFIG_DIR, safeSegment(siteCode))
}

export async function saveConfig(c: StoredConfig): Promise<void> {
  const dir = siteDir(c.siteCode)
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${safeSegment(c.hostname)}.json`)
  // Write then rename, so a crash mid-write never leaves half a file behind.
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(c), "utf8")
  await fs.rename(tmp, file)
}

export async function listConfigs(siteCode: string): Promise<StoredConfig[]> {
  const dir = siteDir(siteCode)
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return []
    throw e
  }
  const out: StoredConfig[] = []
  for (const n of names.filter((n) => n.endsWith(".json"))) {
    try {
      out.push(JSON.parse(await fs.readFile(path.join(dir, n), "utf8")) as StoredConfig)
    } catch {
      // A damaged file is skipped rather than taking the whole site page down.
    }
  }
  return out.sort((a, b) => a.hostname.localeCompare(b.hostname))
}

export async function deleteConfig(siteCode: string, hostname: string): Promise<void> {
  await fs.rm(path.join(siteDir(siteCode), `${safeSegment(hostname)}.json`), { force: true })
}
