// Mirrors prisma/schema.prisma so the sample data and the future database
// rows have the same shape.

export type SiteStatus = "ONLINE" | "DEGRADED" | "OFFLINE"
export type DeviceRole = "ROUTER" | "CORE_SWITCH" | "ACCESS_SWITCH" | "FIREWALL" | "WLC" | "ACCESS_POINT" | "OTHER"
export type DeviceStatus = "UP" | "DOWN" | "WARNING" | "UNKNOWN"

export interface Device {
  id: number
  siteId: number
  hostname: string
  mgmtIp: string
  role: DeviceRole
  vendor: string
  model: string
  serial: string | null
  osVersion: string | null
  status: DeviceStatus
  lastSeen: Date | null
  /** When a running-config for this device was last imported, if ever. */
  configImportedAt: Date | null
}

export interface Subnet {
  id: number
  siteId: number
  cidr: string
  vlan: number | null
  name: string
  gateway: string | null
}

export interface Circuit {
  id: number
  siteId: number
  provider: string
  circuitId: string
  type: string
  bandwidth: string
  status: DeviceStatus
}

export interface Site {
  id: number
  code: string
  name: string
  customer: string
  region: string
  address: string | null
  status: SiteStatus
  contact: string | null
  phone: string | null
  note: string | null
}

export interface SiteDetail extends Site {
  devices: Device[]
  subnets: Subnet[]
  circuits: Circuit[]
}

export interface SiteSummary extends Site {
  deviceCount: number
  devicesDown: number
  devicesWarning: number
  configCount: number
}

export const ROLE_LABEL: Record<DeviceRole, string> = {
  ROUTER: "Router",
  CORE_SWITCH: "Core switch",
  ACCESS_SWITCH: "Access switch",
  FIREWALL: "Firewall",
  WLC: "Wireless controller",
  ACCESS_POINT: "Access point",
  OTHER: "Other",
}
