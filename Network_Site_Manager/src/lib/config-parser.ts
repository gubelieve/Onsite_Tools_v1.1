// Reads a device running-config (Cisco IOS / IOS-XE / NX-OS, and the
// Cisco-like Aruba AOS-CX syntax) into the facts the app needs: hostname,
// version, interfaces with their addresses / VLAN mode / descriptions, and the
// VLAN database. Pure and side-effect free, so the Import page can run it in
// the browser for a preview and the server can run it again on save.

export type Platform = "ios" | "nxos" | "aos-cx" | "unknown"

export interface ParsedInterface {
  name: string
  description: string | null
  ip: string | null
  prefix: number | null
  mode: "access" | "trunk" | "routed" | null
  accessVlan: number | null
  trunkVlans: string | null
  shutdown: boolean
  channelGroup: number | null
}

export interface ParsedVlan { id: number; name: string | null }

export interface ParsedConfig {
  hostname: string | null
  platform: Platform
  version: string | null
  interfaces: ParsedInterface[]
  vlans: ParsedVlan[]
  routing: string[]
  defaultGateway: string | null
  mgmtIp: string | null
}

const MASK_BITS = (mask: string): number | null => {
  const parts = mask.split(".").map(Number)
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null
  const bin = parts.map((p) => p.toString(2).padStart(8, "0")).join("")
  if (!/^1*0*$/.test(bin)) return null
  return bin.indexOf("0") === -1 ? 32 : bin.indexOf("0")
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

export function isIpv4(s: string): boolean {
  const m = IPV4.exec(s)
  return !!m && m.slice(1).every((o) => Number(o) <= 255)
}

export function ipToInt(ip: string): number {
  return ip.split(".").reduce((acc, o) => acc * 256 + Number(o), 0)
}

export function intToIp(n: number): string {
  return [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join(".")
}

/** The network address of ip/prefix, as "a.b.c.d/nn". */
export function networkOf(ip: string, prefix: number): string {
  const size = 2 ** (32 - prefix)
  return `${intToIp(Math.floor(ipToInt(ip) / size) * size)}/${prefix}`
}

/** Parse "10.0.0.1 255.255.255.0" or "10.0.0.1/24". */
function parseAddress(rest: string): { ip: string; prefix: number } | null {
  const slash = /^(\S+)\/(\d{1,2})\b/.exec(rest)
  if (slash && isIpv4(slash[1]) && Number(slash[2]) <= 32) return { ip: slash[1], prefix: Number(slash[2]) }
  const pair = /^(\S+)\s+(\S+)/.exec(rest)
  if (pair && isIpv4(pair[1])) {
    const prefix = MASK_BITS(pair[2])
    if (prefix !== null) return { ip: pair[1], prefix }
  }
  return null
}

export function parseConfig(text: string): ParsedConfig {
  const lines = text.replace(/\r/g, "").split("\n")
  const cfg: ParsedConfig = {
    hostname: null, platform: "unknown", version: null, interfaces: [], vlans: [], routing: [], defaultGateway: null, mgmtIp: null,
  }
  const vlanById = new Map<number, ParsedVlan>()
  let iface: ParsedInterface | null = null
  let vlan: ParsedVlan | null = null
  let sawSwitchportDefault = false

  for (const rawLine of lines) {
    if (!rawLine.trim() || rawLine.trim().startsWith("!")) {
      if (rawLine.trim() === "!") { iface = null; vlan = null }
      continue
    }
    const indented = /^\s/.test(rawLine)
    const line = rawLine.trim()

    if (!indented) {
      iface = null
      vlan = null
      let m: RegExpExecArray | null
      if ((m = /^hostname\s+"?([^"\s]+)"?/i.exec(line))) cfg.hostname = m[1]
      else if ((m = /^switchname\s+(\S+)/i.exec(line))) { cfg.hostname = m[1]; cfg.platform = "nxos" }
      else if ((m = /^version\s+(\S+)/i.exec(line))) cfg.version = m[1]
      else if (/^feature\s+\S+/i.test(line)) cfg.platform = "nxos"
      else if ((m = /^interface\s+(.+)$/i.exec(line))) {
        iface = { name: m[1].trim(), description: null, ip: null, prefix: null, mode: null, accessVlan: null, trunkVlans: null, shutdown: false, channelGroup: null }
        cfg.interfaces.push(iface)
      } else if ((m = /^vlan\s+([\d,\-\s]+)$/i.exec(line))) {
        const ids = expandVlanList(m[1])
        for (const id of ids) if (!vlanById.has(id)) vlanById.set(id, { id, name: null })
        vlan = ids.length === 1 ? vlanById.get(ids[0])! : null
      } else if ((m = /^router\s+(ospf|bgp|eigrp|rip|isis)\b/i.exec(line))) {
        const proto = m[1].toUpperCase()
        if (!cfg.routing.includes(proto)) cfg.routing.push(proto)
      } else if ((m = /^ip default-gateway\s+(\S+)/i.exec(line))) cfg.defaultGateway = m[1]
      else if ((m = /^ip route\s+(?:vrf\s+\S+\s+)?0\.0\.0\.0(?:\s+0\.0\.0\.0|\/0)\s+(\S+)/i.exec(line))) {
        if (isIpv4(m[1])) cfg.defaultGateway ??= m[1]
      } else if (/^no switchport$/i.test(line) || /^system default switchport/i.test(line)) sawSwitchportDefault = true
      else if (/^(ssh server vrf|vsx|mstp)\b/i.test(line)) cfg.platform = "aos-cx"
      continue
    }

    if (vlan) {
      const m = /^name\s+(.+)$/i.exec(line)
      if (m) vlan.name = m[1].trim().replace(/^"|"$/g, "")
      continue
    }
    if (!iface) continue

    let m: RegExpExecArray | null
    if ((m = /^description\s+(.+)$/i.exec(line))) iface.description = m[1].trim().replace(/^"|"$/g, "")
    else if ((m = /^ip(?:v4)? address\s+(.+)$/i.exec(line))) {
      if (/\bsecondary\b/i.test(m[1]) || iface.ip) continue
      const addr = parseAddress(m[1])
      if (addr) { iface.ip = addr.ip; iface.prefix = addr.prefix }
    } else if ((m = /^switchport access vlan\s+(\d+)/i.exec(line)) || (m = /^vlan access\s+(\d+)/i.exec(line))) {
      iface.accessVlan = Number(m[1]); iface.mode ??= "access"
    } else if ((m = /^switchport trunk allowed vlan\s+(?:add\s+)?(.+)$/i.exec(line)) || (m = /^vlan trunk allowed\s+(.+)$/i.exec(line))) {
      iface.trunkVlans = iface.trunkVlans ? `${iface.trunkVlans},${m[1].trim()}` : m[1].trim(); iface.mode = "trunk"
    } else if ((m = /^switchport mode\s+(access|trunk)/i.exec(line))) iface.mode = m[1].toLowerCase() as "access" | "trunk"
    else if (/^vlan trunk native/i.test(line)) iface.mode = "trunk"
    else if (/^no switchport$/i.test(line) || /^routing$/i.test(line)) iface.mode = "routed"
    else if (/^shutdown$/i.test(line)) iface.shutdown = true
    else if (/^no shutdown$/i.test(line)) iface.shutdown = false
    else if ((m = /^channel-group\s+(\d+)/i.exec(line)) || (m = /^lag\s+(\d+)/i.exec(line))) iface.channelGroup = Number(m[1])
  }

  if (cfg.platform === "unknown" && cfg.interfaces.length) cfg.platform = "ios"
  if (sawSwitchportDefault && cfg.platform === "unknown") cfg.platform = "ios"
  cfg.vlans = [...vlanById.values()].sort((a, b) => a.id - b.id)
  cfg.mgmtIp = pickMgmtIp(cfg.interfaces)
  return cfg
}

/** "10,20-22" -> [10,20,21,22]; ignores anything that is not a number or range. */
export function expandVlanList(list: string): number[] {
  const out: number[] = []
  for (const part of list.split(/[,\s]+/)) {
    const r = /^(\d+)-(\d+)$/.exec(part)
    if (r) { for (let v = Number(r[1]); v <= Number(r[2]) && out.length < 4096; v++) out.push(v) }
    else if (/^\d+$/.test(part)) out.push(Number(part))
  }
  return out.filter((v) => v >= 1 && v <= 4094)
}

/** Management address: an interface named or described as management, then Loopback0, then the first SVI, then anything. */
function pickMgmtIp(ifs: ParsedInterface[]): string | null {
  const up = ifs.filter((i) => i.ip && !i.shutdown)
  const find = (pred: (i: ParsedInterface) => boolean) => up.find(pred)?.ip ?? null
  return (
    find((i) => /^(mgmt|management)/i.test(i.name) || /\b(mgmt|management)\b/i.test(i.description ?? "")) ??
    find((i) => /^loopback\s*0$/i.test(i.name)) ??
    find((i) => /^vlan\s*\d+$/i.test(i.name)) ??
    up[0]?.ip ??
    null
  )
}

/** Short form used in labels: GigabitEthernet1/0/1 -> Gi1/0/1. */
export function shortIfName(name: string): string {
  return name
    .replace(/^HundredGigE/i, "Hu")
    .replace(/^FortyGigabitEthernet/i, "Fo")
    .replace(/^TwentyFiveGigE/i, "Twe")
    .replace(/^TenGigabitEthernet/i, "Te")
    .replace(/^GigabitEthernet/i, "Gi")
    .replace(/^FastEthernet/i, "Fa")
    .replace(/^Ethernet/i, "Eth")
    .replace(/^Port-channel/i, "Po")
    .replace(/^Loopback/i, "Lo")
    .replace(/\s+/g, "")
}
