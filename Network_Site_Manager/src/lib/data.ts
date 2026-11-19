import { CIRCUITS, DEVICES, SITES, SUBNETS } from "./sample-data"
import type { Device, SiteDetail, SiteSummary } from "./types"

// The ONE place pages get data from. Today it reads sample-data.ts; when the
// database is up, replace each body with the matching Prisma query
// (import prisma from "./prisma") and keep the signatures, so no page changes.

export async function listSites(): Promise<SiteSummary[]> {
  return SITES.map((s) => {
    const devices = DEVICES.filter((d) => d.siteId === s.id)
    return {
      ...s,
      deviceCount: devices.length,
      devicesDown: devices.filter((d) => d.status === "DOWN").length,
      devicesWarning: devices.filter((d) => d.status === "WARNING").length,
    }
  })
}

export async function getSite(code: string): Promise<SiteDetail | null> {
  const site = SITES.find((s) => s.code.toLowerCase() === code.toLowerCase())
  if (!site) return null
  return {
    ...site,
    devices: DEVICES.filter((d) => d.siteId === site.id),
    subnets: SUBNETS.filter((n) => n.siteId === site.id),
    circuits: CIRCUITS.filter((c) => c.siteId === site.id),
  }
}

export type DeviceWithSite = Device & { siteCode: string; siteName: string }

export async function listDevices(): Promise<DeviceWithSite[]> {
  const byId = new Map(SITES.map((s) => [s.id, s]))
  return DEVICES.map((d) => ({ ...d, siteCode: byId.get(d.siteId)!.code, siteName: byId.get(d.siteId)!.name }))
}
