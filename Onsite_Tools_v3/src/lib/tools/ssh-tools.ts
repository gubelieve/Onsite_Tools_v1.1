/** SSH tools that run show/config commands on every selected Site Inventory device. */
import type { ToolDevice } from "../inventory"
import { escapeRegExp } from "../net/ssh"
import { classifyError, devicesFor, openSession, saveDeviceLog } from "./common"
import { LLDP_FIELDS, parseCdp, parseInventory, parseLldp, parseSnmpCommunities, parseSnmpUsers } from "./parsers"
import { bool, COMMON_DEVICE_FIELDS, num, str, type ToolDef } from "./types"

// ------------------------------------------------------------------ Config Devices
const BASE_COLUMNS = ["IP Address", "Hostname", "Status", "Failure Reason", "Disconnect Status"]

export function commandsFor(device: ToolDevice, commands: string, perDevice: boolean): string[] {
  let text = ""
  if (perDevice) text = Object.entries(device.raw).find(([k]) => ["command", "commands"].includes(k.toLowerCase()))?.[1] ?? ""
  return (text || commands || "").split(/\r?\n/).map((c) => c.trim()).filter(Boolean)
}

export const configDevices: ToolDef = {
  id: "config-devices", name: "Config Devices", category: "SSH Tools", order: 11, icon: "terminal",
  description: "Run verification or configuration commands on many devices from Site Inventory. Each command gets its own result column.",
  fields: [
    ...COMMON_DEVICE_FIELDS,
    { name: "commands", label: "Commands (one per line)", type: "textarea", rows: 5, placeholder: "show version\nshow ip interface brief",
      help: "Sent to every selected device." },
    { name: "perDeviceCommands", label: "Use per-device 'command' column from Site Inventory", type: "checkbox", default: false, width: "half",
      help: "Import a list with a 'command' column. Devices without a command fall back to the text box." },
    { name: "mode", label: "Mode", type: "select", default: "Verify mode", width: "half",
      options: [{ value: "Verify mode", label: "Verify mode" }, { value: "Config mode", label: "Config mode (configure terminal first)" }] },
  ],
  columns: [...BASE_COLUMNS, "Output"],
  runs: [{ id: "run", label: "Run" }],
  async run(ctx, params) {
    const devices = await devicesFor(ctx, params)
    if (!devices.length) return
    const perDevice = bool(params.perDeviceCommands)
    const commandText = str(params.commands)
    const allCommands = [...new Set(devices.flatMap((d) => commandsFor(d, commandText, perDevice)))]
    if (!allCommands.length) { ctx.error("Please enter a command to run (or import a list with a 'command' column and tick the option)."); return }
    const configMode = str(params.mode) === "Config mode"
    const columns = [...BASE_COLUMNS, ...allCommands, "Output"]
    ctx.setColumns(columns, [...BASE_COLUMNS, "Device Category", ...allCommands, "Output", "Log File"])
    const keys = new Map(devices.map((d) => [d.host, ctx.addRow({
      ...Object.fromEntries(columns.map((c) => [c, "-"])), "IP Address": d.host, Hostname: d.hostname, Status: "Pending",
      "Device Category": d.site, Output: "", "Log File": "" })]))
    let ok = 0
    await ctx.mapParallel(devices, async (d) => {
      const key = keys.get(d.host)!
      const commands = commandsFor(d, commandText, perDevice)
      if (!commands.length) { ctx.updateRow(key, { Status: "Skipped", "Failure Reason": "No command" }); return }
      try {
        const s = await openSession(ctx, d, params)
        ctx.updateRow(key, { Status: "Pass", Hostname: s.hostname })
        let full = "", status = "Success", inConfig = configMode
        try {
          if (configMode) await s.configMode().catch((e) => { status = `Config Mode Error: ${e.message}`; full += `[${status}]\n` })
          for (const cmd of commands) {
            if (ctx.stopRequested) { status = "Stopped by user"; full += "[Stopped by user]\n"; break }
            full += `--- ${cmd} ---\n`
            const low = cmd.toLowerCase()
            if (["conf t", "configure terminal", "system-view"].includes(low)) inConfig = true
            if (["end", "return"].includes(low)) inConfig = false
            try {
              const out = await s.send(cmd, { timeoutSec: 120 })
              full += out + "\n"
              ctx.updateRow(key, { [cmd]: out })
            } catch (e) {
              status = `Config Error: ${(e as Error).message}`
              full += `\n[${status}]\n`
              ctx.updateRow(key, { [cmd]: `[${status}]` })
            }
          }
          if (inConfig) await s.exitConfigMode().catch(() => "")
        } finally { s.close() }
        full = `[Command List]\n${commands.join("\n")}\n\n${full}`
        const file = saveDeviceLog(ctx, s.hostname, d.host, full)
        if (status === "Success") ok++
        ctx.updateRow(key, { Status: status, Output: full, "Failure Reason": status === "Success" ? "-" : status,
          "Disconnect Status": "Success", "Log File": file })
        ctx.summary(`Total ${ok}/${devices.length}`)
      } catch (e) {
        const msg = (e as Error).message
        ctx.log(`SSH connection or command error for ${d.host}: ${msg}`, "ERROR")
        ctx.updateRow(key, { Status: "N/A", Output: msg, "Failure Reason": `Fail: ${msg}`, "Disconnect Status": `Fail: ${msg}` })
      }
    }, num(params.threads, 10))
    ctx.info(`Process has completed. Success ${ok}/${devices.length}.`)
  },
}

// ------------------------------------------------------------------ Client Status Checker
export const clientStatusChecker: ToolDef = {
  id: "client-status-checker", name: "Client Status Checker", category: "SSH Tools", order: 20, icon: "search",
  description: "Check on which device a client MAC address is seen (show mac address-table, then show ip arp).",
  fields: [...COMMON_DEVICE_FIELDS,
    { name: "mac", label: "Client MAC address", type: "text", required: true, placeholder: "e.g. aabb.ccdd.eeff" }],
  columns: ["Device Category", "Checked On (IP)", "Hostname", "Client MAC", "Status", "Output"],
  runs: [{ id: "run", label: "Check Status" }],
  async run(ctx, params) {
    const mac = str(params.mac).trim().toLowerCase()
    const devices = await devicesFor(ctx, params)
    if (!devices.length) return
    ctx.setColumns(this.columns)
    const keys = new Map(devices.map((d) => [d.host, ctx.addRow({ "Device Category": d.site, "Checked On (IP)": d.host, Hostname: d.hostname,
      "Client MAC": mac, Status: "Pending...", Output: "" })]))
    let found = 0
    await ctx.mapParallel(devices, async (d) => {
      const key = keys.get(d.host)!
      try {
        const s = await openSession(ctx, d, params)
        let status = "Disconnected", text = ""
        try {
          const out = await s.send(`show mac address-table address ${mac}`)
          text = `--- show mac address-table address ${mac} ---\n${out}\n`
          if (out.toLowerCase().includes(mac)) status = "Connected"
          else {
            const arp = await s.send(`show ip arp ${mac}`)
            text += `--- show ip arp ${mac} ---\n${arp}\n`
            if (arp.toLowerCase().includes(mac)) status = "Connected (ARP)"
          }
        } finally { s.close() }
        if (status.startsWith("Connected")) found++
        ctx.updateRow(key, { Hostname: s.hostname, Status: status, Output: text })
      } catch (e) {
        ctx.log(`SSH error for ${d.host}: ${(e as Error).message}`, "ERROR")
        ctx.updateRow(key, { Status: classifyError(e), Output: (e as Error).message })
      }
    }, num(params.threads, 10))
    ctx.summary(`MAC ${mac} found on ${found} device(s)`)
    ctx.info("Client status check finished.")
  },
}

// ------------------------------------------------------------------ Get Inventory
export const getInventory: ToolDef = {
  id: "get-inventory", name: "Get Inventory", category: "Inventory", order: 30, icon: "package",
  description: "Collect hostname, PID, serial number and software version from each device via SSH.",
  fields: COMMON_DEVICE_FIELDS,
  columns: ["Hostname", "IP Address", "PID", "Serial Number", "Version", "SW Type", "Status", "Output"],
  runs: [{ id: "run", label: "Run" }],
  async run(ctx, params) {
    const devices = await devicesFor(ctx, params)
    if (!devices.length) return
    ctx.setColumns(this.columns, ["Hostname", "IP Address", "PID", "Serial Number", "Version", "SW Type", "Status", "Device Category", "Output"])
    const keys = new Map(devices.map((d) => [d.host, ctx.addRow({ Hostname: d.hostname || "N/A", "IP Address": d.host, PID: "N/A",
      "Serial Number": "N/A", Version: "N/A", "SW Type": "N/A", Status: "Pending...", "Device Category": d.site, Output: "" })]))
    let ok = 0
    await ctx.mapParallel(devices, async (d) => {
      const key = keys.get(d.host)!
      try {
        const s = await openSession(ctx, d, params)
        let ver = "", inv = ""
        try {
          ctx.updateRow(key, { Hostname: s.hostname, Status: "Collecting..." })
          ver = await s.send("show version", { timeoutSec: 90 })
          ctx.checkStop()
          inv = await s.send("show inventory", { timeoutSec: 90 })
        } finally { s.close() }
        const raw = `--- show version ---\n${ver}\n\n--- show inventory ---\n${inv}`
        saveDeviceLog(ctx, s.hostname, d.host, raw)
        ok++
        ctx.updateRow(key, { Status: "Success", Output: raw, ...parseInventory(ver, inv) })
        ctx.summary(`Total ${ok}/${devices.length}`)
      } catch (e) {
        if (ctx.stopRequested) { ctx.updateRow(key, { Status: "Stopped by user" }); return }
        ctx.log(`Error connecting to ${d.host}: ${(e as Error).message}`, "ERROR")
        ctx.updateRow(key, { Status: classifyError(e), Output: (e as Error).message })
      }
    }, num(params.threads, 10))
    ctx.info("Inventory collection finished.")
  },
}

// ------------------------------------------------------------------ CDP / LLDP
function neighbourTool(kind: "cdp" | "lldp"): ToolDef {
  const isCdp = kind === "cdp"
  const columns = isCdp
    ? ["Device Switch", "Device ID", "IP address", "Platform", "Interface", "Port ID", "Version", "Device Category", "raw_output"]
    : ["Device Switch", ...LLDP_FIELDS, "Device Category", "raw_output"]
  const command = isCdp ? "show cdp neighbors detail" : "show lldp neighbors detail"
  return {
    id: `${kind}-inventory`, name: `${kind.toUpperCase()} Inventory`, category: "Inventory", order: isCdp ? 31 : 32, icon: "share",
    description: `Collect ${kind.toUpperCase()} neighbours from each device (${command}).`,
    fields: COMMON_DEVICE_FIELDS, columns, runs: [{ id: "run", label: "Run" }],
    async run(ctx, params) {
      const devices = await devicesFor(ctx, params)
      if (!devices.length) return
      ctx.setColumns(columns)
      const blank = (first: string, note: string, site: string, raw: string) =>
        ({ ...Object.fromEntries(columns.map((c) => [c, ""])), "Device Switch": first, [columns[1]]: note, "Device Category": site, raw_output: raw })
      let ok = 0
      await ctx.mapParallel(devices, async (d) => {
        try {
          const s = await openSession(ctx, d, params)
          let out = ""
          try { out = await s.send(command, { timeoutSec: 90 }) } finally { s.close() }
          saveDeviceLog(ctx, s.hostname, d.host, out)
          const rows = isCdp ? parseCdp(out, s.hostname, d.site) : parseLldp(out, s.hostname, d.site)
          if (!rows.length) ctx.addRow(blank(s.hostname, `(no ${kind.toUpperCase()} neighbours)`, d.site, out))
          for (const r of rows) ctx.addRow(r)
          ok++
          ctx.summary(`Total ${ok}/${devices.length}`)
        } catch (e) {
          if (ctx.stopRequested) return
          const msg = `Error connecting to ${d.host}: ${(e as Error).message}`
          ctx.log(msg, "ERROR")
          ctx.addRow(blank(d.host, classifyError(e), d.site, msg))
        }
      }, num(params.threads, 10))
      ctx.info(`${kind.toUpperCase()} inventory collection finished.`)
    },
  }
}
export const cdpInventory = neighbourTool("cdp")
export const lldpInventory = neighbourTool("lldp")

// ------------------------------------------------------------------ Verify SNMP User
export const verifySnmpUser: ToolDef = {
  id: "verify-snmp-user", name: "Verify SNMP User", category: "Inventory", order: 34, icon: "shield",
  description: "Read 'show run | inc snmp.*community' and 'show snmp user' and summarise SNMPv2/v3 settings per device.",
  fields: COMMON_DEVICE_FIELDS,
  columns: ["Hostname", "IP Management", "SNMPv2 Community String", "SNMPv3 User", "SNMPv3 Active Access-List",
    "Authentication Protocol", "Privacy Protocol", "Group-name", "Status", "Output"],
  runs: [{ id: "run", label: "Run" }],
  async run(ctx, params) {
    const devices = await devicesFor(ctx, params)
    if (!devices.length) return
    ctx.setColumns(this.columns, [...this.columns.slice(0, 8), "Device Category", "Status"])
    const keys = new Map(devices.map((d) => [d.host, ctx.addRow({ ...Object.fromEntries(this.columns.map((c) => [c, ""])),
      Hostname: d.hostname || "N/A", "IP Management": d.host, Status: "Pending...", "Device Category": d.site })]))
    let ok = 0
    await ctx.mapParallel(devices, async (d) => {
      const key = keys.get(d.host)!
      try {
        const s = await openSession(ctx, d, params)
        let comm = "", users = ""
        try {
          comm = await s.send("show run | inc snmp.*community", { timeoutSec: 90 })
          ctx.checkStop()
          users = await s.send("show snmp user", { timeoutSec: 60 })
        } finally { s.close() }
        const raw = `--- show run | inc snmp.*community ---\n${comm}\n\n--- show snmp user ---\n${users}`
        saveDeviceLog(ctx, s.hostname, d.host, raw)
        ok++
        ctx.updateRow(key, { Hostname: s.hostname, "SNMPv2 Community String": parseSnmpCommunities(comm), ...parseSnmpUsers(users),
          Status: "Success", Output: raw })
        ctx.summary(`Total ${ok}/${devices.length}`)
      } catch (e) {
        if (ctx.stopRequested) { ctx.updateRow(key, { Status: "Stopped by user" }); return }
        ctx.log(`Error connecting to ${d.host}: ${(e as Error).message}`, "ERROR")
        ctx.updateRow(key, { Status: classifyError(e), Output: (e as Error).message })
      }
    }, num(params.threads, 10))
    ctx.info("SNMP user verification finished.")
  },
}

export { escapeRegExp }
