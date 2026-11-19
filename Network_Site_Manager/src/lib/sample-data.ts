import type { Circuit, Device, DeviceRole, DeviceStatus, Site, Subnet } from "./types"

// Placeholder data so the pages can be built and reviewed before a database
// exists. Every name and address here is made up. Replace by reading from
// Prisma in src/lib/data.ts — nothing else imports this file.

export const SITES: Site[] = [
  { id: 1, code: "BKK-HQ", name: "Bangkok Head Office", customer: "Customer A", region: "Bangkok", address: "Sathorn, Bangkok", status: "ONLINE", contact: "Network Team", phone: "02-000-0001", note: null },
  { id: 2, code: "BKK-DC1", name: "Bangkok Data Center", customer: "Customer A", region: "Bangkok", address: "Bang Na, Bangkok", status: "DEGRADED", contact: "DC Operations", phone: "02-000-0002", note: "Core-02 PSU replaced 2026-11-10, monitoring." },
  { id: 3, code: "CNX-BR01", name: "Chiang Mai Branch", customer: "Customer B", region: "North", address: "Mueang, Chiang Mai", status: "ONLINE", contact: "Branch IT", phone: "053-000-001", note: null },
  { id: 4, code: "HKT-BR02", name: "Phuket Branch", customer: "Customer B", region: "South", address: "Kathu, Phuket", status: "OFFLINE", contact: "Branch IT", phone: "076-000-002", note: "ISP outage ticket open." },
  { id: 5, code: "KKC-BR03", name: "Khon Kaen Branch", customer: "Customer C", region: "Northeast", address: "Mueang, Khon Kaen", status: "ONLINE", contact: "Branch IT", phone: "043-000-003", note: null },
  { id: 6, code: "CBI-FAC1", name: "Chonburi Factory", customer: "Customer C", region: "East", address: "Amata City, Chonburi", status: "ONLINE", contact: "Plant IT", phone: "038-000-004", note: null },
]

type DeviceSeed = [hostname: string, role: DeviceRole, vendor: string, model: string, status: DeviceStatus]

const DEVICE_SEEDS: Record<number, DeviceSeed[]> = {
  1: [
    ["HQ-RTR-01", "ROUTER", "Cisco", "ISR4451", "UP"],
    ["HQ-FW-01", "FIREWALL", "Fortinet", "FortiGate 200F", "UP"],
    ["HQ-CORE-01", "CORE_SWITCH", "Cisco", "C9500-24Y4C", "UP"],
    ["HQ-CORE-02", "CORE_SWITCH", "Cisco", "C9500-24Y4C", "UP"],
    ["HQ-ACC-01", "ACCESS_SWITCH", "Cisco", "C9300-48P", "UP"],
    ["HQ-ACC-02", "ACCESS_SWITCH", "Cisco", "C9300-48P", "UP"],
    ["HQ-WLC-01", "WLC", "Cisco", "C9800-40", "UP"],
  ],
  2: [
    ["DC1-RTR-01", "ROUTER", "Cisco", "ASR1001-X", "UP"],
    ["DC1-FW-01", "FIREWALL", "Palo Alto", "PA-3220", "UP"],
    ["DC1-CORE-01", "CORE_SWITCH", "Cisco", "N9K-C93180YC", "UP"],
    ["DC1-CORE-02", "CORE_SWITCH", "Cisco", "N9K-C93180YC", "WARNING"],
    ["DC1-TOR-01", "ACCESS_SWITCH", "Cisco", "N9K-C93108TC", "UP"],
  ],
  3: [
    ["CNX-RTR-01", "ROUTER", "Cisco", "ISR1111", "UP"],
    ["CNX-SW-01", "ACCESS_SWITCH", "Cisco", "C9200-24P", "UP"],
    ["CNX-AP-01", "ACCESS_POINT", "Cisco", "C9120AXI", "UP"],
  ],
  4: [
    ["HKT-RTR-01", "ROUTER", "Cisco", "ISR1111", "DOWN"],
    ["HKT-SW-01", "ACCESS_SWITCH", "Cisco", "C9200-24P", "UNKNOWN"],
  ],
  5: [
    ["KKC-RTR-01", "ROUTER", "Fortinet", "FortiGate 60F", "UP"],
    ["KKC-SW-01", "ACCESS_SWITCH", "Aruba", "6100-24G", "UP"],
  ],
  6: [
    ["CBI-FW-01", "FIREWALL", "Fortinet", "FortiGate 100F", "UP"],
    ["CBI-CORE-01", "CORE_SWITCH", "Aruba", "6300M", "UP"],
    ["CBI-ACC-01", "ACCESS_SWITCH", "Aruba", "6100-48G", "UP"],
    ["CBI-ACC-02", "ACCESS_SWITCH", "Aruba", "6100-48G", "WARNING"],
  ],
}

const SEEN = new Date("2026-11-19T08:00:00+07:00")

export const DEVICES: Device[] = Object.entries(DEVICE_SEEDS).flatMap(([siteId, seeds]) =>
  seeds.map(([hostname, role, vendor, model, status], i) => ({
    id: Number(siteId) * 100 + i + 1,
    siteId: Number(siteId),
    hostname,
    mgmtIp: `10.${Number(siteId)}.0.${i + 1}`,
    role,
    vendor,
    model,
    serial: `SN${siteId}${String(i + 1).padStart(4, "0")}`,
    osVersion: vendor === "Cisco" ? "17.9.4a" : vendor === "Fortinet" ? "7.2.8" : vendor === "Aruba" ? "10.13" : "10.2.9",
    status,
    lastSeen: status === "DOWN" || status === "UNKNOWN" ? new Date(SEEN.getTime() - 6 * 3600_000) : SEEN,
    configImportedAt: null,
  })),
)

export const SUBNETS: Subnet[] = SITES.flatMap((s) => [
  { id: s.id * 10 + 1, siteId: s.id, cidr: `10.${s.id}.0.0/24`, vlan: 10, name: "Management", gateway: `10.${s.id}.0.254` },
  { id: s.id * 10 + 2, siteId: s.id, cidr: `10.${s.id}.10.0/23`, vlan: 20, name: "Users", gateway: `10.${s.id}.11.254` },
  { id: s.id * 10 + 3, siteId: s.id, cidr: `10.${s.id}.20.0/24`, vlan: 30, name: "Voice", gateway: `10.${s.id}.20.254` },
  { id: s.id * 10 + 4, siteId: s.id, cidr: `10.${s.id}.30.0/24`, vlan: 40, name: "Wireless", gateway: `10.${s.id}.30.254` },
])

export const CIRCUITS: Circuit[] = SITES.flatMap((s) => [
  { id: s.id * 10 + 1, siteId: s.id, provider: "ISP-1", circuitId: `MPLS-${s.code}`, type: "MPLS", bandwidth: s.id <= 2 ? "1 Gbps" : "100 Mbps", status: s.status === "OFFLINE" ? "DOWN" : "UP" },
  { id: s.id * 10 + 2, siteId: s.id, provider: "ISP-2", circuitId: `INET-${s.code}`, type: "Internet", bandwidth: s.id <= 2 ? "500 Mbps" : "200 Mbps", status: s.status === "OFFLINE" ? "DOWN" : "UP" },
])
