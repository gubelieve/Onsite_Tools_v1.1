import "server-only"
import { listConfigs } from "./config-store"
import { CIRCUITS, DEVICES, SITES, SUBNETS } from "./sample-data"
import { mergeConfigs } from "./site-merge"
import { buildTopology, type Topology } from "./topology"
import type { Device, Site, SiteDetail, SiteSummary } from "./types"

// The ONE place pages get data from. Today: sample-data.ts, updated by the
// configs imported on the Import page (see site-merge.ts). When the database
// is up, replace the sample reads with Prisma queries (import prisma from
// "./prisma") and keep the signatures, so no page changes.

export async function listSites(): Promise<SiteSummary[]> {
  return Promise.all(SITES.map(async (s) => {
    const configs = await listConfigs(s.code)
    const { devices } = mergeConfigs(s, DEVICES.filter((d) => d.siteId === s.id), [], configs)
    return {
      ...s,
      deviceCount: devices.length,
      devicesDown: devices.filter((d) => d.status === "DOWN").length,
      devicesWarning: devices.filter((d) => d.status === "WARNING").length,
      configCount: configs.length,
    }
  }))
}

export async function findSite(code: string): Promise<Site | null> {
  return SITES.find((s) => s.code.toLowerCase() === code.toLowerCase()) ?? null
}

export async function getSite(code: string): Promise<SiteDetail | null> {
  const site = await findSite(code)
  if (!site) return null
  const configs = await listConfigs(site.code)
  const { devices, subnets } = mergeConfigs(
    site,
    DEVICES.filter((d) => d.siteId === site.id),
    SUBNETS.filter((n) => n.siteId === site.id),
    configs,
  )
  return { ...site, devices, subnets, circuits: CIRCUITS.filter((c) => c.siteId === site.id) }
}

export type DeviceWithSite = Device & { siteCode: string; siteName: string }

export async function listDevices(): Promise<DeviceWithSite[]> {
  const perSite = await Promise.all(SITES.map(async (s) => {
    const detail = await getSite(s.code)
    return detail!.devices.map((d) => ({ ...d, siteCode: s.code, siteName: s.name }))
  }))
  return perSite.flat()
}

/** The diagram of one site, built from the configs imported for it. */
export async function getSiteTopology(code: string): Promise<{ topology: Topology; configCount: number } | null> {
  const site = await findSite(code)
  if (!site) return null
  const configs = await listConfigs(site.code)
  const { parsed } = mergeConfigs(site, [], [], configs)
  const known = DEVICES.filter((d) => d.siteId === site.id).map((d) => ({ hostname: d.hostname, role: d.role, mgmtIp: d.mgmtIp }))
  const topology = buildTopology(parsed.map((p) => ({ hostname: p.input.hostname, config: p.cfg })), known)
  return { topology, configCount: configs.length }
}
