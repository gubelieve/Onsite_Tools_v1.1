import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { expandVlanList, networkOf, parseConfig } from "@/lib/config-parser"
import { mergeConfigs } from "@/lib/site-merge"
import { buildTopology } from "@/lib/topology"
import { DEVICES, SITES, SUBNETS } from "@/lib/sample-data"

const SAMPLE_DIR = path.join(__dirname, "..", "samples", "configs", "BKK-HQ")
const samples = readdirSync(SAMPLE_DIR).map((f) => readFileSync(path.join(SAMPLE_DIR, f), "utf8"))

describe("parseConfig", () => {
  it("reads hostname, version, interfaces, VLANs and the management address", () => {
    const cfg = parseConfig(samples.find((s) => s.includes("hostname HQ-CORE-01"))!)
    expect(cfg.hostname).toBe("HQ-CORE-01")
    expect(cfg.version).toBe("17.9")
    expect(cfg.platform).toBe("ios")
    expect(cfg.vlans.map((v) => [v.id, v.name])).toEqual([[10, "Management"], [20, "Users"], [30, "Voice"]])
    const te1 = cfg.interfaces.find((i) => i.name === "TenGigabitEthernet1/0/1")!
    expect([te1.ip, te1.prefix, te1.mode]).toEqual(["10.1.255.2", 30, "routed"])
    expect(cfg.interfaces.find((i) => i.name === "TenGigabitEthernet1/0/23")!.channelGroup).toBe(1)
    expect(cfg.mgmtIp).toBe("10.1.0.2") // Vlan10 is described "Management"
    expect(cfg.routing).toEqual(["OSPF"])
  })

  it("understands NX-OS prefix notation and switchname", () => {
    const cfg = parseConfig("switchname DC-LEAF-1\nfeature ospf\ninterface Ethernet1/1\n  no switchport\n  ip address 10.9.0.1/31\n  no shutdown\n")
    expect(cfg.hostname).toBe("DC-LEAF-1")
    expect(cfg.platform).toBe("nxos")
    expect(cfg.interfaces[0]).toMatchObject({ ip: "10.9.0.1", prefix: 31, mode: "routed", shutdown: false })
  })

  it("marks shut interfaces and ignores secondary addresses", () => {
    const cfg = parseConfig("hostname X\ninterface Gi0/1\n ip address 10.0.0.1 255.255.255.0\n ip address 10.0.1.1 255.255.255.0 secondary\n shutdown\n")
    expect(cfg.interfaces[0]).toMatchObject({ ip: "10.0.0.1", prefix: 24, shutdown: true })
  })

  it("helpers", () => {
    expect(networkOf("10.1.11.2", 23)).toBe("10.1.10.0/23")
    expect(expandVlanList("10,20-22, 5000")).toEqual([10, 20, 21, 22])
  })
})

describe("buildTopology (sample BKK-HQ configs)", () => {
  const imported = samples.map((s) => { const c = parseConfig(s); return { hostname: c.hostname!, config: c } })
  const known = DEVICES.filter((d) => d.siteId === 1).map((d) => ({ hostname: d.hostname, role: d.role, mgmtIp: d.mgmtIp }))
  const t = buildTopology(imported, known)
  const link = (a: string, b: string) => t.links.find((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a))

  it("links router and cores from the shared /30 and the descriptions, as one link", () => {
    const l = link("HQ-RTR-01", "HQ-CORE-01")!
    expect(l.pairs).toHaveLength(1)
    expect(l.sources.sort()).toEqual(["description", "subnet"])
    const [rtrIf, coreIf] = l.a === "HQ-RTR-01" ? [l.pairs[0].aIf, l.pairs[0].bIf] : [l.pairs[0].bIf, l.pairs[0].aIf]
    expect([rtrIf, coreIf]).toEqual(["GigabitEthernet0/0/1", "TenGigabitEthernet1/0/1"])
  })

  it("collapses LAG members into their port-channel", () => {
    const l = link("HQ-CORE-01", "HQ-CORE-02")!
    expect(l.pairs).toEqual([{ aIf: "Port-channel1", bIf: "Port-channel1" }])
  })

  it("pairs both ends of a description-only uplink", () => {
    const l = link("HQ-CORE-02", "HQ-ACC-01")!
    expect(l.pairs).toHaveLength(1)
    expect([l.pairs[0].aIf, l.pairs[0].bIf].sort()).toEqual(["GigabitEthernet1/0/10", "GigabitEthernet1/0/50"])
  })

  it("draws a device that is named but not imported, and ignores shut ports", () => {
    expect(t.nodes.find((n) => n.hostname === "HQ-ACC-02")).toMatchObject({ imported: false, role: "ACCESS_SWITCH" })
    expect(t.nodes.find((n) => n.hostname === "HQ-WLC-01")).toMatchObject({ imported: false, role: "WLC" })
    expect(t.links.every((l) => l.pairs.every((p) => p.aIf !== "GigabitEthernet0/0/3" && p.bIf !== "GigabitEthernet0/0/3"))).toBe(true)
  })

  it("turns shared LAN subnets into segments", () => {
    const mgmt = t.segments.find((s) => s.id === "seg:10.1.0.0/24")!
    expect(mgmt.label).toBe("VLAN 10 · 10.1.0.0/24")
    expect(mgmt.members.map((m) => m.node).sort()).toEqual(["HQ-ACC-01", "HQ-CORE-01", "HQ-CORE-02"])
  })
})

describe("mergeConfigs", () => {
  it("updates the matching device and adds new devices and subnets", () => {
    const site = SITES[0]
    const configs = [
      { hostname: "HQ-CORE-01", importedAt: "2026-11-19T04:00:00Z", raw: samples.find((s) => s.includes("hostname HQ-CORE-01"))! },
      { hostname: "HQ-NEW-SW", importedAt: "2026-11-19T04:00:00Z", raw: "hostname HQ-NEW-SW\ninterface Vlan99\n ip address 10.1.99.5 255.255.255.0\n" },
    ]
    const { devices, subnets } = mergeConfigs(site, DEVICES.filter((d) => d.siteId === 1), SUBNETS.filter((s) => s.siteId === 1), configs)
    const core = devices.find((d) => d.hostname === "HQ-CORE-01")!
    expect(core.mgmtIp).toBe("10.1.0.2")
    expect(core.configImportedAt?.toISOString()).toBe("2026-11-19T04:00:00.000Z")
    expect(devices.find((d) => d.hostname === "HQ-NEW-SW")).toMatchObject({ role: "ACCESS_SWITCH", status: "UNKNOWN" })
    expect(subnets.find((s) => s.cidr === "10.1.99.0/24")).toMatchObject({ vlan: 99, gateway: "10.1.99.5" })
    // An existing CIDR keeps its row rather than gaining a duplicate.
    expect(subnets.filter((s) => s.cidr === "10.1.0.0/24")).toHaveLength(1)
  })
})
