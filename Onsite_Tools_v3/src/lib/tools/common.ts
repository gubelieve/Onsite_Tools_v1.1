/** Helpers shared by device tools. */
import fs from "node:fs"
import path from "node:path"
import type { JobContext } from "../jobs"
import { getDevices, countDevices, type ToolDevice } from "../inventory"
import { SshSession, classifyError } from "../net/ssh"
import { getSettings } from "../settings"
import { safeName, stamp } from "../paths"
import { str, type Params } from "./types"

export { classifyError }

/** Resolve the Site Inventory selection of a run, or explain what is missing. */
export async function devicesFor(ctx: JobContext, params: Params): Promise<ToolDevice[]> {
  const devices = await getDevices(str(params.inventoryList, "All"), str(params.site, "All"))
  if (!devices.length) {
    if ((await countDevices()) === 0) ctx.error("Site Inventory is empty. Open the 'Site Inventory' menu and import a device list first.")
    else ctx.warn("No devices in Site Inventory match the selected device list / device category.")
  }
  return devices
}

export async function openSession(ctx: JobContext, device: ToolDevice, params: Params, fallbackType = "autodetect") {
  const settings = await getSettings()
  const fromInventory = device.deviceType && device.deviceType.toLowerCase() !== "autodetect" ? device.deviceType : ""
  // "10.0.0.1:2222" in Site Inventory = SSH on a non-standard port (port-forwarded devices)
  const [host, port] = /^[^:]+:\d+$/.test(device.host) ? device.host.split(":") : [device.host, ""]
  const session = await SshSession.open({
    host, port: Number(port) || 22, username: str(params.username), password: str(params.password),
    deviceType: fromInventory || str(params.deviceType, fallbackType), timeoutSec: settings.sshTimeout,
  })
  ctx.log(`[SSH CONNECTED] ${device.host} (${session.hostname}) type=${session.detectedType}`)
  return session
}

export function saveDeviceLog(ctx: JobContext, hostname: string, host: string, text: string): string {
  const file = path.join(ctx.runDir, `${safeName(hostname)}-${safeName(host)}_${stamp()}.log`)
  fs.writeFileSync(file, text, "utf8")
  return file
}

/** Uploaded files arrive as [{name, path}] from the form; a folder path is scanned recursively. */
export function collectLogFiles(ctx: JobContext, params: Params, exts = [".log", ".txt"]): string[] {
  const folder = str(params.logFolder).trim().replace(/^"|"$/g, "")
  const files: string[] = []
  if (folder) {
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) { ctx.error(`Folder not found: ${folder}`); return [] }
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (exts.includes(path.extname(e.name).toLowerCase())) files.push(p)
      }
    }
    walk(folder)
    ctx.log(`Found ${files.length} log files in ${folder}`)
    return files.sort()
  }
  const uploaded = Array.isArray(params.logFiles) ? (params.logFiles as { path?: string }[]) : []
  for (const u of uploaded) if (u?.path && fs.existsSync(u.path)) files.push(u.path)
  return files
}

/** Uploads are stored as <stamp>_<n>_<original name>; show the original. */
export function displayName(file: string): string {
  const parts = path.basename(file).split("_")
  return parts.length > 3 && /^\d{4}-\d{2}-\d{2}$/.test(parts[0]) ? parts.slice(3).join("_") : path.basename(file)
}

export function uploadedPath(v: unknown): string {
  if (typeof v === "string") return v
  if (v && typeof v === "object" && "path" in v) return String((v as { path: unknown }).path)
  return ""
}
