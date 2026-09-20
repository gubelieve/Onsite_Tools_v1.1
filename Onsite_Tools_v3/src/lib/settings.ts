import os from "node:os"
import prisma from "./prisma"

/** App defaults kept in the local database. Passwords are never stored here. */
export interface AppSettings {
  username: string
  deviceType: string
  threads: number
  sshTimeout: number
  snmpCommunity: string
}

export const DEFAULT_SETTINGS: AppSettings = {
  username: "", deviceType: "autodetect", threads: 10, sshTimeout: 20, snmpCommunity: "",
}

export async function getSettings(): Promise<AppSettings> {
  const rows = await prisma.setting.findMany()
  const map = new Map(rows.map((r) => [r.key, r.value]))
  return {
    username: map.get("username") ?? DEFAULT_SETTINGS.username,
    deviceType: map.get("deviceType") ?? DEFAULT_SETTINGS.deviceType,
    threads: Number(map.get("threads")) || DEFAULT_SETTINGS.threads,
    sshTimeout: Number(map.get("sshTimeout")) || DEFAULT_SETTINGS.sshTimeout,
    snmpCommunity: map.get("snmpCommunity") ?? DEFAULT_SETTINGS.snmpCommunity,
  }
}

export async function saveSettings(patch: Partial<AppSettings>) {
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULT_SETTINGS)) continue
    await prisma.setting.upsert({ where: { key }, create: { key, value: String(value) }, update: { value: String(value) } })
  }
  return getSettings()
}

/** First non-internal IPv4 address - used as the FTP server address for IOS upgrades. */
export function localIp(): string {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")) return a.address
  }
  return "127.0.0.1"
}
