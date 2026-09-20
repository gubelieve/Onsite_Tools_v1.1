/** Pure text parsers for device output - no I/O, unit-tested in tests/parsers.test.ts. */
import path from "node:path"

export type Rec = Record<string, string>

// ------------------------------------------------------------------ inventory
export function parseInventory(showVer: string, showInv: string): Rec {
  const r: Rec = {}
  let m = /Cisco IOS XE Software, Version (\S+)/.exec(showVer)
  if (m) { r["Version"] = m[1]; r["SW Type"] = "IOS XE" }
  else if ((m = /Cisco IOS Software, .* Version (\S+),/.exec(showVer))) { r["Version"] = m[1]; r["SW Type"] = "IOS" }
  else if ((m = /NXOS: version (\S+)/.exec(showVer))) { r["Version"] = m[1]; r["SW Type"] = "NX-OS" }
  else if ((m = /[Vv]ersion\s+([\w.()]+)/.exec(showVer))) r["Version"] = m[1]
  const pid = /PID:\s*(\S+)\s*,/i.exec(showInv)
  const sn = /SN:\s*(\S+)\s*/i.exec(showInv)
  if (pid) r["PID"] = pid[1]
  if (sn) r["Serial Number"] = sn[1]
  return r
}

// ------------------------------------------------------------------ CDP / LLDP
export function parseCdp(output: string, hostname: string, site: string): Rec[] {
  const rows: Rec[] = []
  for (const block of output.split(/-{3,}\r?\n/)) {
    if (!block.trim() || !block.includes("Device ID")) continue
    const pick = (re: RegExp) => re.exec(block)?.[1]?.trim() ?? ""
    rows.push({
      "Device Switch": hostname,
      "Device ID": pick(/Device ID: ([^\n]+)/),
      "IP address": pick(/Management address\(es\):\s*\n\s*IP address: ([0-9.]+)/) || pick(/Entry address\(es\):\s*\n\s*IP address: ([0-9.]+)/),
      "Platform": pick(/Platform: ([^,\n]+)/),
      "Interface": pick(/Interface: ([^,\n]+)/),
      "Port ID": pick(/Port ID \(outgoing port\): ([^\n]+)/),
      "Version": pick(/Product Version: (\S+)/) || pick(/Version[ :]+([^,\n]+)/),
      "Device Category": site,
      "raw_output": block.trim(),
    })
  }
  return rows
}

export const LLDP_FIELDS = ["Local Intf", "Chassis id", "Port id", "System Name", "F/W revision", "S/W revision",
  "Serial number", "Manufacturer", "Model"]

export function parseLldp(output: string, hostname: string, site: string): Rec[] {
  const rows: Rec[] = []
  for (const block of output.split(/-{3,}\r?\n/)) {
    if (!block.trim() || (!block.includes("Chassis id") && !block.includes("Local Intf"))) continue
    const r: Rec = { "Device Switch": hostname, "Device Category": site, "raw_output": block.trim() }
    for (const f of LLDP_FIELDS) {
      r[f] = new RegExp(f.replace(/[/]/g, "\\/") + ": ([^\\n]+)").exec(block)?.[1]?.trim() ?? ""
    }
    rows.push(r)
  }
  return rows
}

// ------------------------------------------------------------------ SNMP settings on the device
export function parseSnmpCommunities(output: string): string {
  // [ \t]+, not \s+: \s crosses the line break and swallows the next "snmp-server community" line
  return [...output.matchAll(/snmp-server[ \t]+community[ \t]+(\S+)[ \t]+(?:RO|RW)\b/gi)].map((m) => m[1]).join("; ")
}

export function parseSnmpUsers(output: string): Rec {
  const users: Rec[] = []
  for (const section of output.split(/(?:^|\n)(?:User\s+name|Username):\s*/i)) {
    if (!section.trim()) continue
    const first = section.split("\n")[0].trim()
    const pick = (...res: RegExp[]) => { for (const re of res) { const m = re.exec(section); if (m) return m[1].trim() } return "" }
    const u: Rec = {
      user: first.split(/\s+/)[0] ?? "",
      acl: pick(/active\s+access-list:\s*(\S+)/i, /access-list:\s*(\S+)/i, /active\s+access-list\s+(\S+)/i),
      auth: pick(/Authentication\s+Protocol:\s*(\S+(?:[ \t]+\d+)?)/i, /Auth\s+Protocol:\s*(\S+(?:[ \t]+\d+)?)/i),
      priv: pick(/Privacy\s+Protocol:\s*(\S+(?:[ \t]+\d+)?)/i, /Priv\s+Protocol:\s*(\S+(?:[ \t]+\d+)?)/i),
      group: pick(/Group-name:\s*(\S+)/i, /Group\s+name:\s*(\S+)/i),
    }
    if (u.user) users.push(u)
  }
  if (!users.length) return {}
  const combine = (k: string) => [...new Set(users.map((u) => u[k]).filter(Boolean))].join("; ")
  return {
    "SNMPv3 User": users.map((u) => u.user).join("; "),
    "SNMPv3 Active Access-List": combine("acl"),
    "Authentication Protocol": combine("auth"),
    "Privacy Protocol": combine("priv"),
    "Group-name": combine("group"),
  }
}

// ------------------------------------------------------------------ SNMP sysDescr
export function imageType(desc: string): string {
  const d = desc.toLowerCase()
  if (d.includes("ios-xe") || d.includes("ios xe")) return "IOS-XE"
  if (d.includes("nx-os")) return "NX-OS"
  if (d.includes("ios")) return "IOS"
  if (d.includes("junos")) return "Junos"
  if (d.includes("eos") || d.includes("arista")) return "EOS"
  if (d.includes("vrp") || d.includes("huawei")) return "VRP"
  return "Unknown"
}

export function versionFromDescr(desc: string): string {
  return /[Vv]ersion\s*([\d.]+[\w.()]*)/.exec(desc)?.[1] ?? desc
}

// ------------------------------------------------------------------ interface report
export const INTERFACE_COLUMNS = ["hostname", "interface", "switchport_mode", "description", "bpdu_enable",
  "device-tracking attach-policy", "data vlan", "voice vlan", "dot1x authen", "ip pool data", "voice pool data"]

export function hostnameFromLogName(file: string): string {
  let h = path.basename(file).replace(/\.(log|txt)$/i, "")
  for (const re of [/_\d{4}-\d{2}-\d{2}_\d{6}$/, /_\d{8}_\d{6}$/, /_\d{4}-\d{2}-\d{2}$/, /_\d{8}$/]) h = h.replace(re, "")
  return h
}

export function parseVlanNames(content: string): Rec {
  const info: Rec = {}
  for (const m of content.matchAll(/^vlan\s+(\d+)[ \t]*\r?\n((?:[ \t]+[^\n]*\r?\n?)*)/gm)) {
    const name = /^\s*name\s+(.+)$/m.exec(m[2])
    if (name) info[m[1]] = name[1].trim()
  }
  return info
}

export function parseInterfaces(content: string, hostname: string): Rec[] {
  const text = content.replace(/\r\n/g, "\n")
  const vlans = parseVlanNames(text)
  const out: Rec[] = []
  for (const block of text.split(/^interface\s+/m).slice(1)) {
    const lines = block.trim().split("\n")
    const name = lines[0]?.trim()
    if (!name) continue
    const r: Rec = { hostname, interface: name, switchport_mode: "unknown", description: "", bpdu_enable: "",
      "device-tracking attach-policy": "", "data vlan": "unknown", "voice vlan": "unknown", "dot1x authen": "",
      "ip pool data": "", "voice pool data": "" }
    for (const raw of lines.slice(1)) {
      if (!/^\s/.test(raw)) break // left the interface block
      const line = raw.trim()
      let m: RegExpExecArray | null
      if (/^ip\s+address\s+/.test(line)) r.switchport_mode = "route port"
      else if (/^switchport\s+mode\s+/.test(line)) r.switchport_mode = line.includes("access") ? "access" : line.includes("trunk") ? "trunk" : r.switchport_mode
      else if ((m = /^description\s+(.+)$/.exec(line))) r.description = m[1].trim()
      else if (/^spanning-tree\s+bpduguard\s+enable/.test(line)) r.bpdu_enable = "spanning-tree bpduguard enable"
      else if ((m = /^device-tracking\s+attach-policy\s+(.+)$/.exec(line))) r["device-tracking attach-policy"] = m[1].trim()
      else if ((m = /^switchport\s+access\s+vlan\s+(\d+)$/.exec(line))) r["data vlan"] = m[1]
      else if ((m = /^switchport\s+voice\s+vlan\s+(\d+)$/.exec(line))) r["voice vlan"] = m[1]
      else if ((m = /^source\s+template\s+(.+)$/.exec(line))) r["dot1x authen"] = m[1].trim()
    }
    r["ip pool data"] = vlans[r["data vlan"]] ?? ""
    r["voice pool data"] = vlans[r["voice vlan"]] ?? ""
    out.push(r)
  }
  return out
}

// ------------------------------------------------------------------ security health check
export function infoFromLogName(file: string): { ip: string; hostname: string } {
  const name = path.basename(file).replace(/\.(log|txt)$/i, "")
  const ipm = /(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])/.exec(name)
  const ip = ipm?.[1] ?? "Unknown"
  let host = ipm ? name.replace(ip, "") : name
  host = host.replace(/^stage_\d+_/i, "")
  for (const re of [/_\d{4}-\d{2}-\d{2}_\d{6}$/, /_\d{8}_\d{6}$/, /_\d{4}-\d{2}-\d{2}$/, /_\d{8}$/, /_\d{6}$/, /_\d{6}_\d{2}$/]) host = host.replace(re, "")
  host = host.replace(/^[-_\s]+|[-_\s]+$/g, "").replace(/[-_\s]+/g, "_")
  return { ip, hostname: host || "Unknown" }
}

const MODEL_PATTERNS = [/PID:\s*([^\s,\n]+)/i, /Model\s+Number:\s*([^\n]+)/i, /Product\s+name:\s*([^\n]+)/i, /Model:\s*([^\n]+)/i,
  /NAME:\s*"([^"]+)"/i, /DESCR:\s*"([^"]+)"/i]
const VERSION_PATTERNS = [/Cisco\s+IOS\s+XE\s+Software[^,]*,\s+Version\s+(\d+\.\d+\.\d+)/i,
  /Cisco\s+IOS\s+Software[^,]*,\s+Version\s+(\d+\.\d+\.?\d*)/i, /VRP\s+\(R\)\s+software[^,]*,\s+Version\s+(\d+\.\d+\.?\d*)/i,
  /Software\s+Version\s+(\d+\.\d+\.?\d*)/i, /System\s+version:\s+(\d+\.\d+\.?\d*)/i, /Version\s+(\d+\.\d+\.?\d*)/i]

export function detectModel(content: string): string {
  for (const re of MODEL_PATTERNS) { const v = re.exec(content)?.[1]?.trim().replace(/^["']|["']$/g, ""); if (v) return v }
  return ""
}

export function detectVersion(content: string): string {
  for (const re of VERSION_PATTERNS) { const v = re.exec(content)?.[1]?.trim(); if (v) return v }
  return ""
}

/** Look one template column (= a config command) up in a device log. Never reads past the end of the line. */
export function searchConfig(content: string, column: string): string {
  const name = column.replace(".*", "").trim()
  if (!name) return ""
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  if (new RegExp(`^[ \\t]*${esc}[ \\t]*$`, "im").test(content)) return name // command without arguments: present
  for (const re of [new RegExp(`^[ \\t]*${esc}[ \\t]+([^\\n\\r]+)$`, "im"), new RegExp(`${esc}[ \\t]+([^\\n\\r]+)`, "i")]) {
    const v = re.exec(content)?.[1]?.replace(/\s*!.*$/, "").trim()
    if (v) return v
  }
  return ""
}
