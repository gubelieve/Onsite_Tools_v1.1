import fs from "node:fs"
import path from "node:path"

/** Everything is relative to the app folder, so the folder can be copied anywhere. */
export const BASE_DIR = process.env.ONSITE_BASE_DIR || process.cwd()
export const DATA_DIR = path.join(BASE_DIR, "data")
export const LOGS_DIR = path.join(BASE_DIR, "logs")
export const UPLOADS_DIR = path.join(BASE_DIR, "uploads")
export const EXPORTS_DIR = path.join(BASE_DIR, "exports")
export const SCREENSHOTS_DIR = path.join(BASE_DIR, "screenshots")
export const TEMPLATES_DIR = path.join(BASE_DIR, "templates")

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function safeName(text: string, keep = "._-"): string {
  const cleaned = String(text ?? "").trim().replace(new RegExp(`[^A-Za-z0-9${keep.replace(/[-\\\]]/g, "\\$&")}]+`, "g"), "_")
  return cleaned || "unnamed"
}

const pad = (n: number) => String(n).padStart(2, "0")

/** 2026-01-31_235959 */
export function stamp(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

export function hms(d = new Date()): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** logs/<tool>/<stamp>/ - same layout as the Python editions. */
export function makeRunDir(toolId: string): string {
  return ensureDir(path.join(LOGS_DIR, toolId, stamp()))
}

/** True when `target` is inside one of the app's own data folders. */
export function isInsideApp(target: string): boolean {
  const real = path.resolve(target)
  return [LOGS_DIR, EXPORTS_DIR, SCREENSHOTS_DIR, UPLOADS_DIR, TEMPLATES_DIR].some(
    (dir) => real === dir || real.startsWith(dir + path.sep),
  )
}
