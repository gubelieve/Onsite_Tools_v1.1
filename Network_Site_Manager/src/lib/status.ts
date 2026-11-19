import type { DeviceStatus, SiteStatus } from "./types"

export type BadgeVariant = "green" | "red" | "yellow" | "neutral"

export const SITE_STATUS: Record<SiteStatus, { label: string; variant: BadgeVariant }> = {
  ONLINE: { label: "Online", variant: "green" },
  DEGRADED: { label: "Degraded", variant: "yellow" },
  OFFLINE: { label: "Offline", variant: "red" },
}

export const DEVICE_STATUS: Record<DeviceStatus, { label: string; variant: BadgeVariant }> = {
  UP: { label: "Up", variant: "green" },
  WARNING: { label: "Warning", variant: "yellow" },
  DOWN: { label: "Down", variant: "red" },
  UNKNOWN: { label: "Unknown", variant: "neutral" },
}

export function formatSeen(d: Date | null): string {
  return d ? d.toLocaleString("sv-SE", { timeZone: "Asia/Bangkok" }).slice(0, 16) : "—"
}
