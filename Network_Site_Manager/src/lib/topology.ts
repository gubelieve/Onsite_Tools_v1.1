import { networkOf, shortIfName, type ParsedConfig, type ParsedInterface } from "./config-parser"
import type { DeviceRole } from "./types"

// Turns the configs imported for one site into a diagram: devices, the links
// between them, and the shared LAN segments. A running-config does not say
// who is plugged into what, so links are INFERRED, and every link records
// which evidence produced it:
//
//   subnet       both ends sit in the same /30 or /31 — a point-to-point link
//   description  an interface description names the other device
//                ("TO HQ-CORE-01 Gi1/0/10", "UPLINK hq-core-02")
//
// A description may name a device whose config has not been imported yet; it
// still gets a node (drawn dashed) when it is a known device of the site.

export interface TopologyInterface {
  name: string
  description: string | null
  address: string | null
  mode: string | null
  vlan: string | null
  shutdown: boolean
}

export interface TopologyNode {
  id: string
  hostname: string
  role: DeviceRole
  mgmtIp: string | null
  imported: boolean
  platform: string | null
  version: string | null
  interfaces: TopologyInterface[]
}

export interface LinkPair { aIf: string | null; bIf: string | null }

export interface TopologyLink {
  id: string
  a: string
  b: string
  pairs: LinkPair[]
  sources: ("subnet" | "description")[]
}

export interface TopologySegment {
  id: string
  label: string
  members: { node: string; ifName: string; ip: string }[]
}

export interface Topology {
  nodes: TopologyNode[]
  links: TopologyLink[]
  segments: TopologySegment[]
}

export interface ImportedDevice { hostname: string; config: ParsedConfig }
export interface KnownDevice { hostname: string; role: DeviceRole; mgmtIp: string | null }

export function guessRole(hostname: string, cfg?: ParsedConfig): DeviceRole {
  const h = hostname.toUpperCase()
  const has = (re: RegExp) => re.test(h)
  if (has(/(^|[-_.])(FW|FIREWALL|FGT|ASA|PA)\d*([-_.]|$)/)) return "FIREWALL"
  if (has(/(^|[-_.])(WLC)\d*([-_.]|$)/)) return "WLC"
  if (has(/(^|[-_.])(AP)\d*([-_.]|$)/)) return "ACCESS_POINT"
  if (has(/(^|[-_.])(RTR|RT|ROUTER|WAN|CE|PE|BR)\d*([-_.]|$)/)) return "ROUTER"
  if (has(/(^|[-_.])(CORE|CS|DIST|DS|AGG|SPINE)\d*([-_.]|$)/)) return "CORE_SWITCH"
  if (has(/(^|[-_.])(ACC|AS|SW|TOR|LEAF|EDGE)\d*([-_.]|$)/)) return "ACCESS_SWITCH"
  if (cfg) {
    const switching = cfg.interfaces.some((i) => i.mode === "access" || i.mode === "trunk")
    if (!switching && cfg.routing.length) return "ROUTER"
    if (switching) return cfg.routing.length ? "CORE_SWITCH" : "ACCESS_SWITCH"
  }
  return "OTHER"
}

const IF_TOKEN = /\b(HundredGigE|FortyGigabitEthernet|TwentyFiveGigE|TenGigabitEthernet|GigabitEthernet|FastEthernet|Ethernet|Port-channel|Hu|Fo|Twe|Te|Gi|Fa|Eth|Et|Po)\s?(\d+(?:[/.:]\d+)*)\b/i

function ifKey(name: string): string {
  return shortIfName(name).toLowerCase().replace(/^et(?=\d)/, "eth")
}

function sameIf(a: string | null, b: string | null): boolean {
  return !!a && !!b && ifKey(a) === ifKey(b)
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

interface Half { from: string; fromIf: string; to: string; toIfHint: string | null }

export function buildTopology(imported: ImportedDevice[], known: KnownDevice[] = []): Topology {
  const knownBy = new Map(known.map((k) => [k.hostname.toLowerCase(), k]))
  const importedBy = new Map(imported.map((d) => [d.hostname.toLowerCase(), d]))
  const allNames = [...new Set([...imported.map((d) => d.hostname), ...known.map((k) => k.hostname)])]
  // Longest first, so "HQ-CORE-01" wins over a device called "HQ-CORE".
  const matchers = allNames
    .sort((a, b) => b.length - a.length)
    .map((name) => ({ name, re: new RegExp(`(^|[^A-Za-z0-9_-])${escapeRe(name)}(?=$|[^A-Za-z0-9_-])`, "i") }))

  const live = (cfg: ParsedConfig) => cfg.interfaces.filter((i) => !i.shutdown)

  // --- description halves -------------------------------------------------
  const halves: Half[] = []
  for (const dev of imported) {
    const ifs = live(dev.config)
    const poTarget = new Map<number, string>()
    const describedTo = (i: ParsedInterface) => {
      if (!i.description) return null
      const hit = matchers.find((m) => m.name.toLowerCase() !== dev.hostname.toLowerCase() && m.re.test(i.description!))
      return hit?.name ?? null
    }
    for (const i of ifs) {
      const po = /^port-channel\s*(\d+)$/i.exec(i.name) ?? /^lag\s*(\d+)$/i.exec(i.name)
      const to = describedTo(i)
      if (po && to) poTarget.set(Number(po[1]), to)
    }
    for (const i of ifs) {
      const to = describedTo(i)
      if (!to) continue
      // A LAG member pointing at the same device as its port-channel is part of that one link.
      if (i.channelGroup !== null && poTarget.get(i.channelGroup) === to) continue
      const after = i.description!.slice(i.description!.toLowerCase().indexOf(to.toLowerCase()) + to.length)
      const hint = IF_TOKEN.exec(after)
      halves.push({ from: dev.hostname, fromIf: i.name, to, toIfHint: hint ? `${hint[1]}${hint[2]}` : null })
    }
  }

  const links = new Map<string, TopologyLink>()
  const linkFor = (x: string, y: string) => {
    const [a, b] = [x, y].sort((p, q) => p.localeCompare(q))
    const id = `${a}__${b}`
    if (!links.has(id)) links.set(id, { id, a, b, pairs: [], sources: [] })
    return links.get(id)!
  }
  const addPair = (x: string, xIf: string | null, y: string, yIf: string | null, source: "subnet" | "description") => {
    const link = linkFor(x, y)
    const [aIf, bIf] = link.a === x ? [xIf, yIf] : [yIf, xIf]
    const existing = link.pairs.find((p) =>
      (sameIf(p.aIf, aIf) || (!p.aIf || !aIf)) && (sameIf(p.bIf, bIf) || (!p.bIf || !bIf)) && (sameIf(p.aIf, aIf) || sameIf(p.bIf, bIf)),
    )
    if (existing) {
      existing.aIf ??= aIf
      existing.bIf ??= bIf
    } else link.pairs.push({ aIf, bIf })
    if (!link.sources.includes(source)) link.sources.push(source)
  }

  // Pair each half with the opposite half that agrees with it, then whatever is left on its own.
  const used = new Set<number>()
  halves.forEach((h, i) => {
    if (used.has(i)) return
    const j = halves.findIndex((o, k) =>
      k !== i && !used.has(k) && o.from === h.to && o.to === h.from &&
      (!h.toIfHint || sameIf(h.toIfHint, o.fromIf)) && (!o.toIfHint || sameIf(o.toIfHint, h.fromIf)),
    )
    used.add(i)
    if (j >= 0) { used.add(j); addPair(h.from, h.fromIf, h.to, halves[j].fromIf, "description") }
    else addPair(h.from, h.fromIf, h.to, h.toIfHint, "description")
  })

  // --- shared subnets -------------------------------------------------------
  const byNet = new Map<string, { node: string; iface: ParsedInterface }[]>()
  for (const dev of imported) {
    for (const i of live(dev.config)) {
      if (!i.ip || i.prefix === null || i.prefix >= 32) continue
      const net = networkOf(i.ip, i.prefix)
      byNet.set(net, [...(byNet.get(net) ?? []), { node: dev.hostname, iface: i }])
    }
  }
  const segments: TopologySegment[] = []
  for (const [net, members] of byNet) {
    const nodes = new Set(members.map((m) => m.node))
    if (nodes.size < 2) continue
    const prefix = Number(net.split("/")[1])
    if (prefix >= 30 && members.length === 2) {
      addPair(members[0].node, members[0].iface.name, members[1].node, members[1].iface.name, "subnet")
      continue
    }
    const vlan = members.map((m) => /^vlan\s*(\d+)$/i.exec(m.iface.name)?.[1]).find(Boolean)
    segments.push({
      id: `seg:${net}`,
      label: vlan ? `VLAN ${vlan} · ${net}` : net,
      members: members.map((m) => ({ node: m.node, ifName: m.iface.name, ip: m.iface.ip! })),
    })
  }

  // --- nodes ----------------------------------------------------------------
  const referenced = new Set<string>()
  for (const l of links.values()) { referenced.add(l.a); referenced.add(l.b) }
  const nodeNames = [...new Set([...imported.map((d) => d.hostname), ...referenced])]
  const nodes: TopologyNode[] = nodeNames.map((hostname) => {
    const dev = importedBy.get(hostname.toLowerCase())
    const k = knownBy.get(hostname.toLowerCase())
    const cfg = dev?.config
    return {
      id: hostname,
      hostname,
      role: k?.role ?? guessRole(hostname, cfg),
      mgmtIp: cfg?.mgmtIp ?? k?.mgmtIp ?? null,
      imported: !!dev,
      platform: cfg?.platform ?? null,
      version: cfg?.version ?? null,
      interfaces: (cfg?.interfaces ?? []).map((i) => ({
        name: i.name,
        description: i.description,
        address: i.ip ? `${i.ip}/${i.prefix}` : null,
        mode: i.mode,
        vlan: i.mode === "trunk" ? (i.trunkVlans ?? "all") : i.accessVlan !== null ? String(i.accessVlan) : null,
        shutdown: i.shutdown,
      })),
    }
  })

  for (const l of links.values()) l.pairs.sort((p, q) => (p.aIf ?? "").localeCompare(q.aIf ?? "", undefined, { numeric: true }))
  return {
    nodes: nodes.sort((a, b) => a.hostname.localeCompare(b.hostname)),
    links: [...links.values()],
    segments: segments.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })),
  }
}
