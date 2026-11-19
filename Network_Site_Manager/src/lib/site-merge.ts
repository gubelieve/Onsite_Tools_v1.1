import { networkOf, parseConfig, shortIfName, type ParsedConfig } from "./config-parser"
import { guessRole } from "./topology"
import type { Device, Site, Subnet } from "./types"

// How an imported config UPDATES a site: the device with the same hostname
// takes the config's version and management address (a new hostname becomes a
// new device), and every addressed interface contributes its subnet unless
// the site already lists that CIDR. Pure, so it is tested without a disk.

export interface ConfigInput { hostname: string; importedAt: string; raw: string }

const VENDOR: Record<string, string> = { ios: "Cisco", nxos: "Cisco", "aos-cx": "Aruba", unknown: "Unknown" }

export function mergeConfigs(site: Site, devices: Device[], subnets: Subnet[], configs: ConfigInput[]) {
  const parsed: { input: ConfigInput; cfg: ParsedConfig }[] = configs.map((input) => ({ input, cfg: parseConfig(input.raw) }))
  const outDevices = devices.map((d) => ({ ...d }))
  const outSubnets = subnets.map((s) => ({ ...s }))

  parsed.forEach(({ input, cfg }, n) => {
    const at = new Date(input.importedAt)
    const existing = outDevices.find((d) => d.hostname.toLowerCase() === input.hostname.toLowerCase())
    if (existing) {
      existing.osVersion = cfg.version ?? existing.osVersion
      existing.mgmtIp = cfg.mgmtIp ?? existing.mgmtIp
      existing.configImportedAt = at
    } else {
      outDevices.push({
        id: -(site.id * 1000 + n + 1),
        siteId: site.id,
        hostname: input.hostname,
        mgmtIp: cfg.mgmtIp ?? "—",
        role: guessRole(input.hostname, cfg),
        vendor: VENDOR[cfg.platform],
        model: "From imported config",
        serial: null,
        osVersion: cfg.version,
        status: "UNKNOWN",
        lastSeen: null,
        configImportedAt: at,
      })
    }

    const vlanName = new Map(cfg.vlans.map((v) => [v.id, v.name]))
    for (const i of cfg.interfaces) {
      if (!i.ip || i.prefix === null || i.prefix >= 32 || i.shutdown) continue
      const cidr = networkOf(i.ip, i.prefix)
      if (outSubnets.some((s) => s.cidr === cidr)) continue
      const svi = /^vlan\s*(\d+)$/i.exec(i.name)
      const vlan = svi ? Number(svi[1]) : null
      outSubnets.push({
        id: -(site.id * 100000 + outSubnets.length + 1),
        siteId: site.id,
        cidr,
        vlan,
        name: (vlan !== null ? vlanName.get(vlan) : null) ?? i.description ?? `${input.hostname} ${shortIfName(i.name)}`,
        gateway: svi ? i.ip : null,
      })
    }
  })

  outSubnets.sort((a, b) => (a.vlan ?? 9999) - (b.vlan ?? 9999) || a.cidr.localeCompare(b.cidr, undefined, { numeric: true }))
  return { devices: outDevices, subnets: outSubnets, parsed }
}
