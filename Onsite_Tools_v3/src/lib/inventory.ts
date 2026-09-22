/**
 * Site Inventory - device lists are imported once and stored in the local database.
 * Tools never upload a device CSV; they select a list (name given at import) and a site.
 */
import path from "node:path"
import type { Device, Prisma } from "@prisma/client"
import prisma from "./prisma"
import { findCol, type Row } from "./csv"

export const IP_ALIASES = ["ip_address", "ip", "ip_mgmt", "host", "management_ip", "managementipaddress", "ipaddress"]
// "Device Category" is the grouping shown in the UI; older lists call the same column Site or zone.
export const SITE_ALIASES = ["device_category", "category", "site", "zone", "location"]
export const HOSTNAME_ALIASES = ["hostname", "name", "device_name"]
export const STANDARD_COLUMNS = ["List", "Device_Category", "IP_Address", "Hostname", "Device_Type", "Model", "Brand", "Description"]

const isAll = (v?: string | null) => !v || ["All", "All Sites", "All Lists"].includes(v)

export interface ToolDevice {
  host: string
  site: string
  deviceType: string
  hostname: string
  description: string
  raw: Record<string, string>
}

export interface MappedDevice {
  ip: string; site: string; hostname: string; deviceType: string; model: string; brand: string; description: string
  extra: Record<string, string>
}

/** Pure mapping of parsed CSV rows to inventory devices (unit-tested). Later duplicates of an IP win. */
export function mapRows(fields: string[], rows: Row[], defaultSite = ""): { devices: MappedDevice[]; skipped: number } {
  const ipCol = findCol(fields, ...IP_ALIASES)
  if (!ipCol) throw new Error("File must contain an IP column (IP_Address / ip_mgmt / ip / managementIpAddress)")
  const cols = {
    site: findCol(fields, ...SITE_ALIASES),
    hostname: findCol(fields, ...HOSTNAME_ALIASES),
    deviceType: findCol(fields, "device_type", "devicetype"),
    model: findCol(fields, "model", "pid", "platform_id"),
    brand: findCol(fields, "brand", "vendor", "os"),
    description: findCol(fields, "description", "desc", "remark", "note"),
  }
  const used = new Set([ipCol, ...Object.values(cols).filter(Boolean)] as string[])
  const byIp = new Map<string, MappedDevice>()
  let skipped = 0
  for (const r of rows) {
    const ip = (r[ipCol] ?? "").trim()
    if (!ip) { skipped++; continue }
    const pick = (c: string | null) => (c ? (r[c] ?? "").trim() : "")
    const extra: Record<string, string> = {}
    for (const [k, v] of Object.entries(r)) if (k && !used.has(k) && v !== "") extra[k] = v
    byIp.set(ip, {
      ip, site: pick(cols.site) || defaultSite.trim(), hostname: pick(cols.hostname), deviceType: pick(cols.deviceType),
      model: pick(cols.model), brand: pick(cols.brand), description: pick(cols.description), extra,
    })
  }
  return { devices: [...byIp.values()], skipped }
}

export async function importRows(fields: string[], rows: Row[], listName: string, filename: string,
                                 mode: "merge" | "replace" = "merge", defaultSite = "") {
  const list = listName.trim() || path.parse(filename).name || "default"
  const { devices, skipped } = mapRows(fields, rows, defaultSite)
  let added = 0, updated = 0, removed = 0
  await prisma.$transaction(async (tx) => {
    if (mode === "replace") removed = (await tx.device.deleteMany({ where: { list } })).count
    const existing = new Set((await tx.device.findMany({ where: { list }, select: { ip: true } })).map((d) => d.ip))
    for (const d of devices) {
      const data = { site: d.site, hostname: d.hostname, deviceType: d.deviceType, model: d.model, brand: d.brand,
        description: d.description, extra: JSON.stringify(d.extra), source: filename }
      if (existing.has(d.ip)) { await tx.device.update({ where: { list_ip: { list, ip: d.ip } }, data }); updated++ }
      else { await tx.device.create({ data: { list, ip: d.ip, ...data } }); added++ }
    }
    await tx.importLog.create({ data: { list, filename, mode, rows: rows.length, added, updated, skipped, removed } })
  }, { timeout: 120000 })
  return { list, filename, mode, rows: rows.length, added, updated, skipped, removed }
}

function where(list?: string | null, site?: string | null, q?: string | null): Prisma.DeviceWhereInput {
  const w: Prisma.DeviceWhereInput = {}
  if (!isAll(list)) w.list = list!
  if (!isAll(site)) w.site = site!
  if (q?.trim()) {
    const s = q.trim()
    w.OR = ["list", "site", "ip", "hostname", "deviceType", "model", "brand", "description", "extra"].map(
      (f) => ({ [f]: { contains: s } }))
  }
  return w
}

export async function listDevices(list?: string | null, site?: string | null, q?: string | null, take = 500, skip = 0) {
  const w = where(list, site, q)
  const [total, devices] = await Promise.all([
    prisma.device.count({ where: w }),
    prisma.device.findMany({ where: w, orderBy: [{ list: "asc" }, { site: "asc" }, { ip: "asc" }], take, skip }),
  ])
  return { total, devices }
}

export async function summary() {
  const [groups, siteGroups, logs] = await Promise.all([
    prisma.device.groupBy({ by: ["list"], _count: { _all: true }, _max: { updatedAt: true }, orderBy: { list: "asc" } }),
    prisma.device.groupBy({ by: ["list", "site"], orderBy: [{ list: "asc" }, { site: "asc" }] }),
    prisma.importLog.findMany({ orderBy: { importedAt: "desc" }, take: 30 }),
  ])
  const lastFile = new Map<string, string>()
  for (const l of [...logs].reverse()) lastFile.set(l.list, l.filename)
  const lists = groups.map((g) => ({
    name: g.list, count: g._count._all, updated: g._max.updatedAt?.toISOString() ?? "",
    sites: siteGroups.filter((s) => s.list === g.list && s.site).map((s) => s.site), filename: lastFile.get(g.list) ?? "",
  }))
  const sites = [...new Set(siteGroups.map((s) => s.site).filter(Boolean))].sort()
  return { lists, sites, total: lists.reduce((n, l) => n + l.count, 0), imports: logs }
}

export async function listNames(): Promise<string[]> {
  return (await prisma.device.groupBy({ by: ["list"], orderBy: { list: "asc" } })).map((g) => g.list)
}

export async function sitesOf(list?: string | null): Promise<string[]> {
  const rows = await prisma.device.groupBy({ by: ["site"], where: where(list), orderBy: { site: "asc" } })
  return rows.map((r) => r.site).filter(Boolean)
}

function toToolDevice(d: Device): ToolDevice {
  let extra: Record<string, string> = {}
  try { extra = JSON.parse(d.extra) } catch { /* keep empty */ }
  return {
    host: d.ip, site: d.site, deviceType: d.deviceType, hostname: d.hostname, description: d.description,
    raw: { ...extra, List: d.list, Device_Category: d.site, IP_Address: d.ip, Hostname: d.hostname, Device_Type: d.deviceType,
      Model: d.model, Brand: d.brand, Description: d.description },
  }
}

/**
 * The same IP may live in several lists; a run contacts it once. First row wins, so the order the rows
 * come back in decides which list's details are used. Shared by the run and by the preview shown in the
 * form, so what the user sees listed is exactly what the run will work on.
 */
export function dedupeByIp<T extends { ip: string }>(rows: T[], max = Infinity): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const d of rows) {
    if (seen.has(d.ip)) continue
    seen.add(d.ip)
    out.push(d)
    if (out.length >= max) break
  }
  return out
}

/** Devices for a tool run, de-duplicated by IP (the same IP may live in several lists). */
export async function getDevices(list?: string | null, site?: string | null, max = 5000): Promise<ToolDevice[]> {
  const rows = await prisma.device.findMany({ where: where(list, site), orderBy: [{ list: "asc" }, { ip: "asc" }] })
  return dedupeByIp(rows, max).map(toToolDevice)
}

export interface PreviewDevice { ip: string; hostname: string; site: string; deviceType: string; model: string; description: string; list: string }

/** The devices a run with this selection would contact - for the list shown under the selectors. */
export async function previewDevices(list?: string | null, site?: string | null, max = 300): Promise<PreviewDevice[]> {
  const rows = await prisma.device.findMany({
    where: where(list, site), orderBy: [{ list: "asc" }, { ip: "asc" }],
    select: { ip: true, hostname: true, site: true, deviceType: true, model: true, description: true, list: true },
  })
  return dedupeByIp(rows, max)
}

export async function countDevices(list?: string | null, site?: string | null): Promise<number> {
  const rows = await prisma.device.groupBy({ by: ["ip"], where: where(list, site) })
  return rows.length
}

export interface DeviceInput {
  id?: string; list: string; site?: string; ip: string; hostname?: string; deviceType?: string; model?: string
  brand?: string; description?: string
}

export async function upsertDevice(input: DeviceInput) {
  const ip = input.ip?.trim()
  const list = input.list?.trim() || "manual"
  if (!ip) throw new Error("IP address is required")
  const data = { list, ip, site: input.site?.trim() ?? "", hostname: input.hostname?.trim() ?? "",
    deviceType: input.deviceType?.trim() ?? "", model: input.model?.trim() ?? "", brand: input.brand?.trim() ?? "",
    description: input.description?.trim() ?? "" }
  const clash = await prisma.device.findUnique({ where: { list_ip: { list, ip } } })
  if (clash && clash.id !== input.id) throw new Error(`${ip} already exists in list "${list}"`)
  return input.id
    ? prisma.device.update({ where: { id: input.id }, data })
    : prisma.device.create({ data: { ...data, source: "manual" } })
}

export const deleteDevice = (id: string) => prisma.device.delete({ where: { id } })
export const deleteList = async (list: string) => (await prisma.device.deleteMany({ where: { list } })).count

export async function exportRows(list?: string | null, site?: string | null) {
  const devices = await prisma.device.findMany({ where: where(list, site), orderBy: [{ list: "asc" }, { site: "asc" }, { ip: "asc" }] })
  const extraCols: string[] = []
  const rows = devices.map((d) => {
    const t = toToolDevice(d)
    for (const k of Object.keys(t.raw)) if (!STANDARD_COLUMNS.includes(k) && !extraCols.includes(k)) extraCols.push(k)
    return t.raw
  })
  return { columns: [...STANDARD_COLUMNS, ...extraCols], rows }
}
