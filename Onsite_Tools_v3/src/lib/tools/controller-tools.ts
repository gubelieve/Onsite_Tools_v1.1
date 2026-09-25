/** Catalyst Center (DNAC) and SD-WAN vManage tools. */
import fs from "node:fs"
import path from "node:path"
import { parseCsv, findCol, toCsv } from "../csv"
import { baseUrl, HttpSession } from "../net/http"
import { SCREENSHOTS_DIR, BASE_DIR, ensureDir, hms, safeName, stamp } from "../paths"
import type { JobContext } from "../jobs"
import { devicesFor, uploadedPath } from "./common"
import { bool, INVENTORY_FIELDS, num, str, type FieldDef, type Params, type ToolDef } from "./types"

const STAGE_COLUMNS = ["Stage", "Hostname", "Status", "Message", "Progress", "Output", "Timestamp"]
export const VERIFY_SSL: FieldDef = { name: "verifySsl", label: "Verify SSL certificate", type: "checkbox", default: false, width: "half",
  help: "Untick for self-signed certificates." }

const emitter = (ctx: JobContext) => (stage: string, host: string, status: string, message: string, progress: number | string = "", output = "") =>
  ctx.addRow({ Stage: stage, Hostname: host, Status: status, Message: message, Progress: String(progress), Output: output, Timestamp: hms() })

function readCsvParam(params: Params, name: string) {
  const file = uploadedPath(params[name])
  if (!file || !fs.existsSync(file)) throw new Error("Please upload the CSV file")
  return parseCsv(fs.readFileSync(file, "utf8"))
}

export async function dnacLogin(params: Params) {
  const http = new HttpSession(bool(params.verifySsl))
  const base = baseUrl(str(params.baseUrl))
  const r = await http.request("POST", `${base}/dna/system/api/v1/auth/token`, { basicAuth: [str(params.username), str(params.password)], timeoutSec: 30 })
  const token = r.status < 300 ? (r.json<{ Token?: string }>().Token ?? "") : ""
  if (!token) throw new Error(`Authentication failed: HTTP ${r.status} ${r.text.slice(0, 200)}`)
  http.headers = { "X-Auth-Token": token, Accept: "application/json", "Content-Type": "application/json" }
  return { http, base }
}

export const CONTROLLER_LOGIN: FieldDef[] = [
  { name: "baseUrl", label: "Controller URL", type: "text", required: true, placeholder: "https://10.0.0.1", remember: true },
  { name: "username", label: "Username", type: "text", required: true, width: "half", remember: true },
  { name: "password", label: "Password", type: "password", required: true, width: "half", remember: true },
]

// ------------------------------------------------------------------ DNAC port assignment
const PA_FIELDS = ["fabricId", "networkDeviceId", "interfaceName", "connectedDeviceType", "dataVlanName", "voiceVlanName",
  "authenticateTemplateName", "interfaceDescription"]
const RESULT_FIELDS = ["hostname", "managementIpAddress", "platformId", "softwareVersion", "serialNumber", "instanceUuid",
  "instanceTenantId", "id", ...PA_FIELDS]

export const dnacPortAssignment: ToolDef = {
  id: "dnac-port-assignment", name: "DNAC Port Assignment", category: "Catalyst Center / SD-WAN", order: 61, icon: "cable",
  description: "For each selected Site Inventory device fetch the Catalyst Center network-device record and its SDA port assignments.",
  fields: [
    ...CONTROLLER_LOGIN,
    { name: "scope", label: "Scope", type: "select", default: "inventory",
      options: [{ value: "inventory", label: "Devices from Site Inventory" }, { value: "all", label: "Dump all port assignments (no device list)" }] },
    ...INVENTORY_FIELDS.map((f) => ({ ...f, showIf: { scope: "inventory" } })),
    VERIFY_SSL,
  ],
  columns: STAGE_COLUMNS,
  runs: [{ id: "run", label: "Run (GET)" }],
  async run(ctx, params) {
    ctx.setColumns(STAGE_COLUMNS)
    const emit = emitter(ctx)
    try {
      const { http, base } = await dnacLogin(params)
      emit("Auth", "DNAC", "Pass", "Authenticated", 5)
      const get = async (pathname: string, query?: Record<string, string>) => {
        const r = await http.get(base + pathname, { query })
        return r.status === 200 ? { ok: true as const, data: r.json<Record<string, unknown>>() } : { ok: false as const, data: `HTTP ${r.status}: ${r.text.slice(0, 500)}` }
      }
      if (str(params.scope) === "all") {
        const r = await get("/dna/intent/api/v1/sda/portAssignments")
        const out = r.ok ? JSON.stringify(r.data, null, 2) : String(r.data)
        emit("GET", "portAssignments", r.ok ? "Completed" : "Failed", "Fetched assignments", 100, out)
        if (r.ok) { const f = path.join(ctx.runDir, "portAssignments.json"); fs.writeFileSync(f, out); ctx.artifact("portAssignments.json", f) }
        return
      }
      const devices = (await devicesFor(ctx, params)).map((d) => ({ hostname: d.hostname || d.description || d.host, ip: d.host }))
      if (!devices.length) throw new Error("No devices selected from Site Inventory")
      ctx.progress(0, devices.length)
      const results: Record<string, unknown>[] = []
      for (const [i, d] of devices.entries()) {
        ctx.checkStop()
        const pct = Math.round(20 + ((i + 1) / devices.length) * 70)
        const dev = await get("/dna/intent/api/v1/network-device", { managementIpAddress: d.ip })
        const item = dev.ok ? ((dev.data.response as Record<string, unknown>[] | undefined)?.[0]) : undefined
        if (!item) { emit("Device", d.hostname, "Failed", `Device not found for IP ${d.ip}`, pct, JSON.stringify(dev.data)); ctx.step(); continue }
        const baseRow: Record<string, unknown> = { hostname: d.hostname, managementIpAddress: d.ip }
        for (const k of ["platformId", "softwareVersion", "serialNumber", "instanceUuid", "instanceTenantId", "id"]) baseRow[k] = item[k] ?? ""
        const pa = await get("/dna/intent/api/v1/sda/portAssignments", { networkDeviceId: String(baseRow.id) })
        const list = pa.ok ? ((pa.data.response as Record<string, unknown>[] | undefined) ?? []) : []
        if (list.length) for (const a of list) results.push({ ...baseRow, ...Object.fromEntries(PA_FIELDS.map((k) => [k, a[k] ?? ""])) })
        else results.push({ ...baseRow, ...Object.fromEntries(PA_FIELDS.map((k) => [k, ""])) })
        emit("Device", d.hostname, "Completed", `Collected device and ${list.length} port assignment(s)`, pct, JSON.stringify(results[results.length - 1], null, 2))
        ctx.step()
      }
      const file = path.join(ctx.runDir, `result_${stamp()}.csv`)
      fs.writeFileSync(file, toCsv(RESULT_FIELDS, results), "utf8")
      ctx.artifact(path.basename(file), file)
      emit("Export", "CSV", "Completed", `Saved result CSV: ${file}`, 100, file)
      ctx.summary(`${results.length} port-assignment rows from ${devices.length} device(s)`)
    } catch (e) {
      ctx.log(`dnac_port_assignment failed: ${(e as Error).message}`, "ERROR")
      emit("Error", "dnac", "Failed", (e as Error).message, 0)
    }
    ctx.info("DNAC processing finished.")
  },
}

// ------------------------------------------------------------------ SD-WAN site list
export const sdWanApi: ToolDef = {
  id: "sd-wan-api", name: "SD-WAN API (Site List)", category: "Catalyst Center / SD-WAN", order: 62, icon: "globe",
  description: "Login to vManage, POST /template/policy/list/site for every group in the CSV and verify the list exists afterwards.",
  fields: [...CONTROLLER_LOGIN,
    { name: "csvFile", label: "Site list CSV", type: "file", accept: ".csv", required: true, template: "sd_wan_site_list_template.csv",
      help: "Columns: name, description, type, listId, siteId" }, VERIFY_SSL],
  columns: STAGE_COLUMNS,
  runs: [{ id: "run", label: "Run" }],
  async run(ctx, params) {
    ctx.setColumns(STAGE_COLUMNS)
    const emit = emitter(ctx)
    try {
      const { fields, rows } = readCsvParam(params, "csvFile")
      const need = ["name", "description", "type", "listId", "siteId"]
      const cols = Object.fromEntries(need.map((c) => { const real = findCol(fields, c); if (!real) throw new Error(`Missing required column: ${c}`); return [c, real] }))
      const items = rows.map((r) => Object.fromEntries(need.map((k) => [k, (r[cols[k]] ?? "").trim()]))).filter((i) => i.name && i.type && i.siteId)
      if (!items.length) throw new Error("CSV has no valid data rows")
      const base = baseUrl(str(params.baseUrl))
      const http = new HttpSession(bool(params.verifySsl))
      emit("Auth", "vManage", "Running", "Authenticating to vManage...", 10)
      for (const p of ["/j_security_check", "/dataservice/j_security_check"]) {
        const r = await http.postForm(base + p, { j_username: str(params.username), j_password: str(params.password) }).catch(() => null)
        if (r && r.status === 200 && !String(r.headers["content-type"] ?? "").includes("html")) break
      }
      for (const p of ["/dataservice/client/token", "/client/token"]) {
        const t = await http.get(base + p, { timeoutSec: 20 }).catch(() => null)
        if (t && t.status === 200 && t.text && !t.text.toLowerCase().includes("<html")) { http.headers["X-XSRF-TOKEN"] = t.text.trim(); break }
      }
      emit("Auth", "vManage", "Pass", "Authenticated (or proceeding without token)", 15)
      const groups = new Map<string, { name: string; description: string; type: string; listId: string | null; entries: { siteId: string }[] }>()
      for (const it of items) {
        const listId = !it.listId || it.listId.toLowerCase() === "null" ? null : it.listId
        const key = JSON.stringify([it.name, it.description, it.type, listId])
        if (!groups.has(key)) groups.set(key, { name: it.name, description: it.description, type: it.type, listId, entries: [] })
        groups.get(key)!.entries.push({ siteId: it.siteId })
      }
      ctx.progress(0, groups.size)
      let idx = 0, passed = 0
      const endpoints = ["/dataservice/template/policy/list/site", "/template/policy/list/site"]
      for (const payload of groups.values()) {
        ctx.checkStop()
        idx++
        const pct = Math.round(15 + (idx / groups.size) * 80)
        const pretty = JSON.stringify(payload, null, 2)
        emit("POST", payload.name, "Running", `Posting site list with ${payload.entries.length} entries`, pct, pretty)
        let ok = false, code: number | null = null, text = "Unknown error"
        for (const ep of endpoints) {
          try { const r = await http.postJson(base + ep, payload); code = r.status; text = r.text; if (r.status >= 200 && r.status < 300) { ok = true; break } }
          catch (e) { text = (e as Error).message }
        }
        fs.writeFileSync(path.join(ctx.runDir, `group_${String(idx).padStart(3, "0")}_${safeName(payload.name)}.log`),
          `REQUEST:\n${pretty}\n\nRESPONSE:\nHTTP ${code ?? "NA"}\n${text}`, "utf8")
        emit("POST", payload.name, ok ? "Completed" : "Failed", `HTTP ${code ?? "NA"}: ${ok ? "vManage accepted request" : text.slice(0, 300)}`, pct, text)
        let found = false, vcode: number | null = null
        for (const ep of endpoints) {
          const r = await http.get(base + ep).catch(() => null)
          if (r && r.status === 200) {
            vcode = 200
            try { found = ((r.json<{ data?: { name?: string; type?: string }[] }>().data) ?? []).some((i) => i.name === payload.name && i.type === payload.type) }
            catch { found = r.text.includes(payload.name) }
            break
          }
        }
        if (ok && found) passed++
        emit("Verify", payload.name, ok && found ? "Pass" : ok ? "Warning" : "Failed", `Verify GET HTTP ${vcode ?? "NA"}: ${found ? "Found" : "Not found"}`, pct)
        ctx.step()
      }
      emit("Done", "All", "Completed", `Processed ${groups.size} group(s)`, 100)
      ctx.summary(`${passed}/${groups.size} site list(s) verified`)
    } catch (e) {
      ctx.log(`sd_wan_api failed: ${(e as Error).message}`, "ERROR")
      emit("Error", "sd-wan", "Failed", (e as Error).message, 0)
    }
    ctx.info("SD-WAN API processing finished.")
  },
}

// ------------------------------------------------------------------ Capture DNAC (screenshots)
function findBrowser(): string | null {
  const env = process.env
  const candidates = [
    env.CHROME_PATH,
    path.join(env["PROGRAMFILES"] ?? "", "Google/Chrome/Application/chrome.exe"),
    path.join(env["PROGRAMFILES(X86)"] ?? "", "Google/Chrome/Application/chrome.exe"),
    path.join(env["LOCALAPPDATA"] ?? "", "Google/Chrome/Application/chrome.exe"),
    path.join(env["PROGRAMFILES(X86)"] ?? "", "Microsoft/Edge/Application/msedge.exe"),
    path.join(env["PROGRAMFILES"] ?? "", "Microsoft/Edge/Application/msedge.exe"),
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ]
  return candidates.find((c) => c && fs.existsSync(c)) ?? null
}

export const captureDnac: ToolDef = {
  id: "capture-dnac", name: "Capture DNAC (Screenshots)", category: "Catalyst Center / SD-WAN", order: 63, icon: "camera",
  description: "Open each URL from the CSV in Chrome or Edge, log in using the XPaths given, and save a screenshot to screenshots/.",
  fields: [
    { name: "csvFile", label: "Capture list (CSV)", type: "file", accept: ".csv", required: true, template: "dnac_capture_template.csv",
      help: "Columns: url, username, password, xpath_user, xpath_pwd, xpath_login, description, session_type (login|direct)" },
    { name: "pageWait", label: "Page load wait (s)", type: "number", default: 15, min: 1, max: 120, width: "half" },
    { name: "headless", label: "Headless browser", type: "checkbox", default: true, width: "half", help: "Untick to watch the browser window." },
  ],
  columns: ["Stage", "Status", "Message", "Time"],
  runs: [{ id: "run", label: "Start Capture" }],
  async run(ctx, params) {
    ctx.setColumns(this.columns)
    const emit = (stage: string, status: string, message: string) => ctx.addRow({ Stage: stage, Status: status, Message: message, Time: hms() })
    const rows = readCsvParam(params, "csvFile").rows.filter((r) => r.url).slice(0, 1000)
    emit("Setup", "Success", `Loaded ${rows.length} rows from CSV`)
    if (!rows.length) return
    const exe = findBrowser()
    if (!exe) { emit("Setup", "Error", `Chrome or Edge not found. Install Google Chrome or set CHROME_PATH (app folder: ${BASE_DIR}).`); return }
    const puppeteer = (await import("puppeteer-core")).default
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const wait = num(params.pageWait, 15) * 1000
    const browser = await puppeteer.launch({ executablePath: exe, headless: bool(params.headless), acceptInsecureCerts: true,
      defaultViewport: { width: 1920, height: 1080 }, args: ["--start-maximized", "--ignore-certificate-errors"] })
    emit("Setup", "Success", `Browser started: ${path.basename(exe)}`)
    ensureDir(SCREENSHOTS_DIR)
    ctx.progress(0, rows.length)
    let shots = 0
    try {
      const page = await browser.newPage()
      for (const [i, row] of rows.entries()) {
        if (ctx.stopRequested) { emit("Stopped", "Info", "Capture process stopped by user"); break }
        emit("Processing", "Info", `Processing row ${i + 1}/${rows.length}`)
        try {
          await page.goto(row.url, { waitUntil: "networkidle2", timeout: 90000 }).catch(() => null)
          if ((row.session_type || "login").toLowerCase() === "login") {
            await sleep(wait)
            const el = async (xp: string) => { const h = await page.waitForSelector(`xpath/${xp}`, { timeout: 30000 }); if (!h) throw new Error(`Element not found: ${xp}`); return h }
            await (await el(row.xpath_user)).type(row.username ?? "")
            await (await el(row.xpath_pwd)).type(row.password ?? "")
            await (await el(row.xpath_login)).click()
            emit("Login", "Success", `Login submitted for ${row.description || row.url}`)
            await sleep(6000)
          } else await sleep(6000)
          const file = path.join(SCREENSHOTS_DIR, `${safeName(row.description || "dnac")}_${stamp()}.png`) as `${string}.png`
          await page.screenshot({ path: file })
          shots++
          ctx.artifact(path.basename(file), file)
          emit("Capture", "Success", `Screenshot saved: ${file}`)
        } catch (e) {
          emit("Processing", "Error", `Error processing row ${i + 1}: ${(e as Error).message}`)
        }
        ctx.step()
      }
    } finally {
      await browser.close().catch(() => null)
      emit("Cleanup", "Success", "Browser closed")
    }
    ctx.summary(`${shots} screenshot(s) saved to ${SCREENSHOTS_DIR}`)
    ctx.info("DNAC capture process finished.")
  },
}
