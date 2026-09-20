/** SNMP inventory and the log-analysis tools (no SSH). */
import fs from "node:fs"
import path from "node:path"
import { parseCsv, toCsv } from "../csv"
import { EXPORTS_DIR, TEMPLATES_DIR, ensureDir, makeRunDir, safeName, stamp } from "../paths"
import { collectLogFiles, devicesFor, displayName } from "./common"
import { detectModel, detectVersion, hostnameFromLogName, imageType, infoFromLogName, INTERFACE_COLUMNS, parseInterfaces,
  searchConfig, versionFromDescr } from "./parsers"
import { INVENTORY_FIELDS, num, str, type ToolDef } from "./types"

// ------------------------------------------------------------------ SNMP inventory
const OIDS = { hostname: "1.3.6.1.2.1.1.5.0", descr: "1.3.6.1.2.1.1.1.0", serial: "1.3.6.1.2.1.47.1.1.1.1.11.1", pid: "1.3.6.1.2.1.47.1.1.1.1.13.1" }

export const snmpInventory: ToolDef = {
  id: "snmp-inventory", name: "SNMP Inventory", category: "Inventory", order: 33, icon: "activity",
  description: "Query hostname, version, serial number and PID via SNMP v2c or v3 (no SSH needed).",
  fields: [
    ...INVENTORY_FIELDS,
    { name: "version", label: "SNMP version", type: "select", default: "2c", width: "half", options: [{ value: "2c", label: "2c" }, { value: "3", label: "3" }] },
    { name: "community", label: "Community (v2c)", type: "password", width: "half", showIf: { version: "2c" }, defaultFrom: "snmpCommunity", remember: true },
    { name: "user", label: "User (v3)", type: "text", width: "half", showIf: { version: "3" } },
    { name: "authKey", label: "Auth key (v3)", type: "password", width: "half", showIf: { version: "3" } },
    { name: "authProto", label: "Auth protocol", type: "select", width: "half", default: "sha", showIf: { version: "3" },
      options: ["md5", "sha", "sha224", "sha256", "sha384", "sha512"].map((v) => ({ value: v, label: v.toUpperCase() })) },
    { name: "privKey", label: "Priv key (v3)", type: "password", width: "half", showIf: { version: "3" } },
    { name: "privProto", label: "Priv protocol", type: "select", width: "half", default: "aes", showIf: { version: "3" },
      options: [{ value: "des", label: "DES" }, { value: "aes", label: "AES128" }, { value: "aes256b", label: "AES256 (Blumenthal)" }, { value: "aes256r", label: "AES256 (Reeder / Cisco)" }] },
    { name: "timeout", label: "Timeout (s)", type: "number", default: 3, min: 1, max: 30, width: "half" },
    { name: "concurrency", label: "Concurrency", type: "number", default: 50, min: 1, max: 200, width: "half" },
  ],
  columns: ["Hostname", "IP Address", "PID", "Serial Number", "Version", "Image Type", "Status", "sysDescr"],
  runs: [{ id: "run", label: "Get SNMP Inventory" }],
  async run(ctx, params) {
    const devices = await devicesFor(ctx, params)
    if (!devices.length) return
    const v3 = str(params.version) === "3"
    if (v3 && !str(params.user)) { ctx.error("Please enter the SNMPv3 user name."); return }
    if (!v3 && !str(params.community)) { ctx.error("Please enter the SNMP community."); return }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snmp: any = (await import("net-snmp")).default ?? (await import("net-snmp"))
    const options = { timeout: num(params.timeout, 3) * 1000, retries: 1, version: v3 ? snmp.Version3 : snmp.Version2c }
    ctx.setColumns(this.columns, [...this.columns, "Device Category"])
    const keys = new Map(devices.map((d) => [d.host, ctx.addRow({ Hostname: "", "IP Address": d.host, PID: "", "Serial Number": "", Version: "",
      "Image Type": "", Status: "Pending...", sysDescr: "", "Device Category": d.site })]))
    let ok = 0
    await ctx.mapParallel(devices, (d) => new Promise<void>((resolve) => {
      const key = keys.get(d.host)!
      let session
      try {
        if (v3) {
          const user: Record<string, unknown> = { name: str(params.user), level: snmp.SecurityLevel.noAuthNoPriv }
          if (str(params.authKey)) { user.level = snmp.SecurityLevel.authNoPriv; user.authProtocol = snmp.AuthProtocols[str(params.authProto, "sha")]; user.authKey = str(params.authKey) }
          if (str(params.authKey) && str(params.privKey)) { user.level = snmp.SecurityLevel.authPriv; user.privProtocol = snmp.PrivProtocols[str(params.privProto, "aes")]; user.privKey = str(params.privKey) }
          session = snmp.createV3Session(d.host, user, options)
        } else session = snmp.createSession(d.host, str(params.community), options)
      } catch (e) { ctx.updateRow(key, { Status: `Error: ${(e as Error).message}` }); return resolve() }
      session.get(Object.values(OIDS), (error: Error | null, varbinds: { value: unknown }[]) => {
        try { session.close() } catch { /* ignore */ }
        if (error) { ctx.updateRow(key, { Status: `Failed: ${error.message}` }); return resolve() }
        const val = (i: number) => (snmp.isVarbindError(varbinds[i]) ? "" : String(varbinds[i].value ?? ""))
        const descr = val(1)
        ok++
        ctx.updateRow(key, { Hostname: val(0), sysDescr: descr, "Serial Number": val(2), PID: val(3), Version: versionFromDescr(descr),
          "Image Type": imageType(descr), Status: val(2) || val(3) ? "Success" : "Partial" })
        resolve()
      })
    }), num(params.concurrency, 50))
    ctx.summary(`Total ${ok}/${devices.length}`)
    ctx.info("SNMP inventory finished.")
  },
}

// ------------------------------------------------------------------ Interface report
const LOG_FIELDS: ToolDef["fields"] = [
  { name: "logFolder", label: "Log folder", type: "path", kind: "folder", placeholder: "C:\\path\\to\\logs",
    help: "Folder on this PC, scanned recursively for *.log / *.txt files." },
  { name: "logFiles", label: "...or upload log files", type: "files", accept: ".log,.txt", help: "Used when no folder is given." },
]

export const interfaceReport: ToolDef = {
  id: "interface-report", name: "Interface Report", category: "Log Analysis", order: 50, icon: "file-text",
  description: "Parse 'show running-config' log files (e.g. from Config Devices) into a per-interface report.",
  fields: [...LOG_FIELDS, { name: "outputName", label: "Output CSV name", type: "text", default: "interface_report.csv", width: "half" }],
  columns: INTERFACE_COLUMNS,
  runs: [{ id: "run", label: "Generate Report" }],
  async run(ctx, params) {
    const files = collectLogFiles(ctx, params)
    if (!files.length) { ctx.error("No .log files found. Give a folder path or upload log files."); return }
    ctx.setColumns(INTERFACE_COLUMNS)
    ctx.progress(0, files.length)
    const all: Record<string, string>[] = []
    for (const file of files) {
      ctx.checkStop()
      try {
        const rows = parseInterfaces(fs.readFileSync(file, "utf8"), hostnameFromLogName(displayName(file)))
        rows.forEach((r) => ctx.addRow(r))
        all.push(...rows)
      } catch (e) { ctx.warn(`Error processing ${displayName(file)}: ${(e as Error).message}`) }
      ctx.step()
    }
    const name = safeName(str(params.outputName, "interface_report.csv").replace(/\.csv$/i, ""))
    const out = path.join(ensureDir(EXPORTS_DIR), `${name}_${stamp()}.csv`)
    fs.writeFileSync(out, toCsv(INTERFACE_COLUMNS, all), "utf8")
    ctx.artifact(path.basename(out), out)
    ctx.summary(`${all.length} interfaces from ${files.length} file(s)`)
    ctx.info(`CSV exported with ${all.length} interfaces: ${out}`)
  },
}

// ------------------------------------------------------------------ Security health check
export const securityHealthCheck: ToolDef = {
  id: "security-health-check", name: "Security Health Check", category: "Log Analysis", order: 51, icon: "shield-check",
  description: "Detect model and version from device logs, then look up every configuration item listed as a column in the template CSV.",
  fields: [...LOG_FIELDS,
    { name: "templateFile", label: "Template CSV (optional upload)", type: "file", accept: ".csv", template: "shc_template.csv",
      help: "Columns: brand, zone, model, then one column per config command. Default: templates/shc_template.csv" }],
  columns: ["IP_Address", "Hostname", "Model Detect", "Version Detect", "Template Match"],
  runs: [{ id: "run", label: "Generate Report" }],
  async run(ctx, params) {
    const files = collectLogFiles(ctx, params)
    if (!files.length) { ctx.error("No .log files found. Give a folder path or upload log files."); return }
    const uploaded = params.templateFile as { path?: string } | undefined
    const templatePath = uploaded?.path || path.join(TEMPLATES_DIR, "shc_template.csv")
    if (!fs.existsSync(templatePath)) { ctx.error(`Template file not found: ${templatePath}`); return }
    const tpl = parseCsv(fs.readFileSync(templatePath, "utf8"))
    const checks = tpl.fields.filter((c) => !["brand", "zone", "model"].includes(c.toLowerCase()))
    const columns = [...this.columns, ...checks]
    ctx.setColumns(columns)
    ctx.progress(0, files.length)
    const results: Record<string, string>[] = []
    for (const file of files) {
      ctx.checkStop()
      try {
        const content = fs.readFileSync(file, "utf8")
        const { ip, hostname } = infoFromLogName(displayName(file))
        const model = detectModel(content)
        const match = model ? tpl.rows.find((t) => { const m = (t.model ?? "").toLowerCase(); const d = model.toLowerCase(); return m && (m === d || d.includes(m) || m.includes(d)) }) : undefined
        const row: Record<string, string> = { IP_Address: ip, Hostname: hostname, "Model Detect": model, "Version Detect": detectVersion(content),
          "Template Match": match?.model ?? "(none)" }
        for (const c of checks) row[c] = match ? searchConfig(content, c) : ""
        ctx.addRow(row)
        results.push(row)
      } catch (e) { ctx.warn(`Error processing ${displayName(file)}: ${(e as Error).message}`) }
      ctx.step()
    }
    const out = path.join(makeRunDir("security-health-check"), `shc_result_${stamp()}.csv`)
    fs.writeFileSync(out, toCsv(columns, results), "utf8")
    ctx.artifact(path.basename(out), out)
    ctx.summary(`${results.length} device(s) checked against ${checks.length} items`)
    ctx.info(`CSV exported successfully with ${results.length} results: ${out}`)
  },
}
