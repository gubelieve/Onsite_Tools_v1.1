/**
 * DNAC REST API - call any Catalyst Center endpoint without writing a script.
 *
 * What the API expects (Catalyst Center 2.3.7 / 3.x, developer.cisco.com/docs/catalyst-center):
 *  - POST /dna/system/api/v1/auth/token with Basic auth returns { Token }, good for 60 minutes,
 *    sent back as the X-Auth-Token header on every other call.
 *  - Paths live under /dna/intent/api/v1 (configuration), /dna/data/api/v1 (assurance) and
 *    /dna/system/api/v1 (the box itself).
 *  - Lists are paged with offset + limit, **offset counts from 1**, and 500 records is the maximum page.
 *  - Answers are wrapped: { "response": ..., "version": "..." }.
 *  - Every POST / PUT / DELETE answers with a taskId instead of the result; the result is read from
 *    /dna/intent/api/v1/task/{id}, and when that task produced a file, from /dna/intent/api/v1/file/{fileId}.
 * All four are handled here so the person using it only picks an endpoint and presses a button.
 */
import fs from "node:fs"
import path from "node:path"
import { findCol, parseCsv } from "../csv"
import { safeName, stamp } from "../paths"
import { CONTROLLER_LOGIN, dnacLogin, VERIFY_SSL } from "./controller-tools"
import { uploadedPath } from "./common"
import { bool, num, str, type Option, type Params, type ToolDef } from "./types"

/** Endpoints worth having one click away. Value is "METHOD path" so the method travels with the choice. */
const CATALOG: [group: string, method: string, path: string, label: string][] = [
  ["Devices", "GET", "/dna/intent/api/v1/network-device", "All devices (paged)"],
  ["Devices", "GET", "/dna/intent/api/v1/network-device/count", "Device count"],
  ["Devices", "GET", "/dna/intent/api/v1/network-device/{id}", "One device by UUID"],
  ["Devices", "GET", "/dna/intent/api/v1/network-device/ip-address/{ip}", "One device by management IP"],
  ["Devices", "GET", "/dna/intent/api/v1/network-device/{id}/config", "Running config of one device"],
  ["Devices", "GET", "/dna/intent/api/v1/network-device/module", "Modules (needs deviceId=… in the query)"],
  ["Devices", "GET", "/dna/intent/api/v1/interface", "All interfaces (paged)"],
  ["Devices", "GET", "/dna/intent/api/v1/interface/network-device/{id}", "Interfaces of one device"],
  ["Sites", "GET", "/dna/intent/api/v1/site", "Sites"],
  ["Sites", "GET", "/dna/intent/api/v1/site/count", "Site count"],
  ["Sites", "GET", "/dna/intent/api/v1/membership/{id}", "Devices in a site"],
  ["Health", "GET", "/dna/intent/api/v1/network-health", "Network health"],
  ["Health", "GET", "/dna/intent/api/v1/site-health", "Site health"],
  ["Health", "GET", "/dna/intent/api/v1/client-health", "Client health"],
  ["Health", "GET", "/dna/intent/api/v1/issues", "Assurance issues"],
  ["Health", "GET", "/dna/intent/api/v1/client-detail", "One client (needs macAddress=… in the query)"],
  ["SDA", "GET", "/dna/intent/api/v1/sda/portAssignments", "SDA port assignments"],
  ["SDA", "GET", "/dna/intent/api/v1/sda/fabricSites", "SDA fabric sites"],
  ["Software", "GET", "/dna/intent/api/v1/image/importation", "SWIM images"],
  ["Software", "GET", "/dna/intent/api/v1/template-programmer/template", "Configuration templates"],
  ["Software", "GET", "/dna/intent/api/v1/compliance", "Compliance state"],
  ["Command Runner", "GET", "/dna/intent/api/v1/network-device-poller/cli/legit-reads", "Commands the API is allowed to run"],
  ["Command Runner", "POST", "/dna/intent/api/v1/network-device-poller/cli/read-request", "Run show commands (body: commands + deviceUuids)"],
  ["Tasks & files", "GET", "/dna/intent/api/v1/task/{id}", "Task by id"],
  ["Tasks & files", "GET", "/dna/intent/api/v1/file/{id}", "File by id"],
]

export const CATALOG_OPTIONS: Option[] = [
  { value: "custom", label: "Custom path (type it below)" },
  ...CATALOG.map(([group, method, p, label]) => ({ value: `${method} ${p}`, label: `${group} · ${label} — ${method} ${p}` })),
]

/** "key=value" lines, so a query string never has to be escaped by hand. Blank lines and # comments are ignored. */
export function parseQuery(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith("#")) continue
    const i = t.indexOf("=")
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim()
  }
  return out
}

export const pathPlaceholders = (p: string): string[] => [...p.matchAll(/\{([^}]+)\}/g)].map((m) => m[1])

/** Every {placeholder} in the path gets the same value - endpoints here never take more than one. */
export const fillPath = (p: string, value: string): string => p.replace(/\{[^}]+\}/g, encodeURIComponent(value.trim()))

const MAX_COLUMNS = 40
const MAX_CELL = 2000

/** A value as one table cell: objects and arrays as compact JSON rather than "[object Object]". */
export function cell(v: unknown): string {
  if (v === null || v === undefined) return ""
  if (typeof v === "object") { const s = JSON.stringify(v); return s.length > MAX_CELL ? s.slice(0, MAX_CELL) + "…" : s }
  return String(v)
}

/** One object as Field / Value rows, nested keys as "a.b.c" - how you read a single device record. */
export function flattenObject(obj: Record<string, unknown>, prefix = "", depth = 0): Record<string, string>[] {
  const rows: Record<string, string>[] = []
  for (const [k, v] of Object.entries(obj)) {
    const field = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === "object" && !Array.isArray(v) && depth < 4) rows.push(...flattenObject(v as Record<string, unknown>, field, depth + 1))
    else rows.push({ Field: field, Value: cell(v) })
  }
  return rows
}

/** Whatever the API returned, as a table. A list becomes one row per item, a single record becomes Field/Value. */
export function toRows(data: unknown): { columns: string[]; rows: Record<string, string>[] } {
  if (Array.isArray(data)) {
    if (!data.length) return { columns: [], rows: [] }
    if (data.some((x) => x === null || typeof x !== "object")) {
      return { columns: ["Value"], rows: data.map((x) => ({ Value: cell(x) })) }
    }
    const columns: string[] = []
    for (const item of data as Record<string, unknown>[]) {
      for (const k of Object.keys(item)) if (!columns.includes(k) && columns.length < MAX_COLUMNS) columns.push(k)
    }
    return { columns, rows: (data as Record<string, unknown>[]).map((item) => Object.fromEntries(columns.map((c) => [c, cell(item[c])]))) }
  }
  if (data && typeof data === "object") return { columns: ["Field", "Value"], rows: flattenObject(data as Record<string, unknown>) }
  return { columns: ["Value"], rows: [{ Value: cell(data) }] }
}

/** The id of the background job a write request started, whichever name this endpoint uses for it. */
export function taskIdOf(body: unknown): string {
  const b = body as { response?: { taskId?: string; executionId?: string }; executionId?: string } | null
  return str(b?.response?.taskId || b?.response?.executionId || b?.executionId)
}

/** The task's progress field is sometimes JSON with the id of a file holding the real answer. */
export function fileIdOf(progress: unknown): string {
  if (typeof progress !== "string") return ""
  try { return str((JSON.parse(progress) as { fileId?: string }).fileId) } catch { return "" }
}

const PAGE_MAX = 500

export const dnacRestApi: ToolDef = {
  id: "dnac-rest-api", name: "DNAC REST API", category: "Catalyst Center / SD-WAN", order: 60, icon: "cloud",
  description: "Call any Catalyst Center API: pick an endpoint or type a path, and read the answer as a table. " +
    "Logs in, follows the pages, and waits for the task that a POST/PUT/DELETE starts.",
  fields: [
    ...CONTROLLER_LOGIN, VERIFY_SSL,
    { name: "api", label: "Endpoint", type: "select", default: "GET /dna/intent/api/v1/network-device", options: CATALOG_OPTIONS,
      help: "Catalyst Center 2.3.7 / 3.x paths. Pick 'Custom path' to type any other one." },
    { name: "path", label: "Custom path", type: "text", showIf: { api: "custom" }, placeholder: "/dna/intent/api/v1/network-device/count",
      help: "Everything after the controller address. A full URL works too." },
    { name: "method", label: "Method", type: "select", default: "GET", width: "half", showIf: { api: "custom" },
      options: ["GET", "POST", "PUT", "DELETE"].map((m) => ({ value: m, label: m })) },
    { name: "pathValue", label: "Value for {id} / {ip} in the path", type: "text", width: "half",
      placeholder: "e.g. 10.0.205.249 or a device UUID", help: "Only needed when the chosen endpoint has {…} in it." },
    { name: "query", label: "Query parameters (one key=value per line)", type: "textarea", rows: 3,
      placeholder: "hostname=SW-CORE-01\nfamily=Switches and Hubs", help: "No escaping needed. Lines starting with # are ignored." },
    { name: "body", label: "JSON body (POST / PUT / DELETE)", type: "textarea", rows: 5,
      placeholder: '{\n  "commands": ["show version"],\n  "deviceUuids": ["<device uuid>"]\n}' },
    { name: "allPages", label: "Fetch every page (offset / limit)", type: "checkbox", default: true, width: "half",
      help: "Catalyst Center returns at most 500 records per call; this keeps asking until the list ends." },
    { name: "maxRows", label: "Stop after this many records", type: "number", default: 5000, min: 1, max: 100000, width: "half" },
    { name: "waitForTask", label: "Wait for the task a write request starts", type: "checkbox", default: true, width: "half",
      help: "Follows taskId, then downloads the file it produced (this is how Command Runner returns output)." },
    { name: "taskWait", label: "Task timeout (s)", type: "number", default: 120, min: 5, max: 900, width: "half" },
    { name: "urlFile", label: "URL list (CSV) — only for 'Run URL list'", type: "file", accept: ".csv", template: "dnac_urls_template.csv",
      help: "Columns: URL_Name, Endpoint. Used by the second button, which GETs every row." },
  ],
  columns: ["Field", "Value"],
  runs: [
    { id: "send", label: "Send request" },
    { id: "csv", label: "Run URL list (CSV)", params: { batch: true } },
  ],
  async run(ctx, params) {
    let session: Awaited<ReturnType<typeof dnacLogin>>
    try {
      session = await dnacLogin(params)
      ctx.info(`Authenticated to ${session.base} (token is valid for 60 minutes).`)
    } catch (e) { ctx.error((e as Error).message); return }
    if (bool(params.batch)) return batchFromCsv(ctx, params, session)

    const chosen = str(params.api, "custom")
    const method = (chosen === "custom" ? str(params.method, "GET") : chosen.split(" ")[0]).toUpperCase()
    let endpoint = chosen === "custom" ? str(params.path).trim() : chosen.slice(chosen.indexOf(" ") + 1)
    if (!endpoint) { ctx.error("Please choose an endpoint, or type a custom path."); return }
    const needs = pathPlaceholders(endpoint)
    if (needs.length && !str(params.pathValue).trim()) {
      ctx.error(`This endpoint needs a value for {${needs[0]}} - fill in "Value for {id} / {ip} in the path".`)
      return
    }
    endpoint = fillPath(endpoint, str(params.pathValue))
    const url = /^https?:\/\//i.test(endpoint) ? endpoint : session.base + (endpoint.startsWith("/") ? "" : "/") + endpoint
    const query = parseQuery(str(params.query))
    const bodyText = str(params.body).trim()
    if (method !== "GET" && bodyText) {
      try { JSON.parse(bodyText) } catch (e) { ctx.error(`The JSON body is not valid JSON: ${(e as Error).message}`); return }
    }

    ctx.setColumns(["Field", "Value"])
    ctx.info(`${method} ${url}`)
    let data: unknown
    let note = ""
    try {
      if (method === "GET") {
        const got = await getAll(ctx, session, url, query, bool(params.allPages), num(params.maxRows, 5000))
        data = got.data
        note = got.note
      } else {
        const res = await session.http.request(method, withQuery(url, query), { body: bodyText || undefined, timeoutSec: 120 })
        ctx.info(`HTTP ${res.status}`)
        const parsed = safeJson(res.text)
        if (res.status >= 300) { failed(ctx, res.status, res.text); return }
        data = unwrap(parsed)
        if (bool(params.waitForTask)) {
          const task = taskIdOf(parsed)
          if (task) {
            const followed = await followTask(ctx, session, task, num(params.taskWait, 120))
            data = followed.data ?? data
            note = followed.note
          }
        }
      }
    } catch (e) { ctx.error(`Request failed: ${(e as Error).message}`); return }

    const { columns, rows } = toRows(data)
    if (!rows.length) {
      ctx.setColumns(["Field", "Value"])
      ctx.addRow({ Field: "Result", Value: "The call succeeded and returned no records." })
    } else {
      ctx.setColumns(columns)
      for (const r of rows) ctx.addRow(r)
    }
    const file = path.join(ctx.runDir, `${safeName(endpoint.split("?")[0].split("/").filter(Boolean).slice(-2).join("_") || "response")}_${stamp()}.json`)
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8")
    ctx.artifact(path.basename(file), file)
    ctx.summary(`${rows.length} record(s)${note ? ` · ${note}` : ""}`)
    ctx.info(`Saved the raw JSON to ${file}`)
  },
}

const withQuery = (url: string, query: Record<string, string>) => {
  const u = new URL(url)
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v)
  return u.toString()
}

const safeJson = (text: string): unknown => { try { return JSON.parse(text) } catch { return text } }

/** Catalyst Center wraps everything in { response, version }. */
const unwrap = (body: unknown): unknown =>
  body && typeof body === "object" && "response" in (body as Record<string, unknown>) ? (body as { response: unknown }).response : body

function failed(ctx: Parameters<ToolDef["run"]>[0], status: number, text: string) {
  ctx.setColumns(["Field", "Value"])
  ctx.addRow({ Field: "HTTP status", Value: String(status) })
  ctx.addRow({ Field: "Response", Value: text.slice(0, 20000) })
  ctx.error(`HTTP ${status}: ${text.slice(0, 300)}`)
  ctx.summary(`HTTP ${status}`)
}

type Session = Awaited<ReturnType<typeof dnacLogin>>

/** offset counts from 1 and a page holds at most 500 records - keep asking until a short page comes back. */
async function getAll(ctx: Parameters<ToolDef["run"]>[0], session: Session, url: string, query: Record<string, string>,
                      allPages: boolean, maxRows: number): Promise<{ data: unknown; note: string }> {
  const first = await session.http.get(withQuery(url, allPages && !query.offset ? { ...query, offset: "1", limit: String(Math.min(PAGE_MAX, maxRows)) } : query), { timeoutSec: 120 })
  ctx.info(`HTTP ${first.status}`)
  if (first.status >= 300) { failed(ctx, first.status, first.text); return { data: [], note: `HTTP ${first.status}` } }
  const data = unwrap(safeJson(first.text))
  if (!allPages || !Array.isArray(data) || query.offset) return { data, note: "" }

  const limit = Math.min(PAGE_MAX, maxRows)
  const all = [...data]
  let page = 1
  while (all.length >= limit * page && all.length < maxRows) {
    ctx.checkStop()
    const res = await session.http.get(withQuery(url, { ...query, offset: String(all.length + 1), limit: String(limit) }), { timeoutSec: 120 })
    if (res.status >= 300) { ctx.warn(`Page ${page + 1} failed with HTTP ${res.status} - keeping the ${all.length} record(s) already read.`); break }
    const next = unwrap(safeJson(res.text))
    if (!Array.isArray(next) || !next.length) break
    all.push(...next)
    page++
    ctx.progress(all.length, all.length)
    ctx.info(`Page ${page}: ${all.length} record(s) so far`)
  }
  const cut = all.length > maxRows
  return { data: cut ? all.slice(0, maxRows) : all, note: `${page} page(s)${cut ? `, stopped at ${maxRows}` : ""}` }
}

/** A write request answers with a taskId; the answer itself is behind the task, sometimes behind a file. */
async function followTask(ctx: Parameters<ToolDef["run"]>[0], session: Session, taskId: string, waitSec: number): Promise<{ data: unknown; note: string }> {
  ctx.info(`Task ${taskId} started - waiting up to ${waitSec}s for it to finish.`)
  const until = Date.now() + waitSec * 1000
  let last: Record<string, unknown> = {}
  while (Date.now() < until) {
    ctx.checkStop()
    await new Promise((r) => setTimeout(r, 2000))
    const res = await session.http.get(`${session.base}/dna/intent/api/v1/task/${encodeURIComponent(taskId)}`, { timeoutSec: 30 })
    if (res.status >= 300) return { data: { taskId, error: `HTTP ${res.status}`, body: res.text.slice(0, 2000) }, note: "task read failed" }
    last = (unwrap(safeJson(res.text)) ?? {}) as Record<string, unknown>
    if (last.isError === true) {
      ctx.error(`The task failed: ${str(last.failureReason) || str(last.progress)}`)
      return { data: last, note: "task failed" }
    }
    if (last.endTime) {
      const fileId = fileIdOf(last.progress)
      if (!fileId) return { data: last, note: "task finished" }
      ctx.info(`Task finished and wrote file ${fileId} - downloading it.`)
      const file = await session.http.get(`${session.base}/dna/intent/api/v1/file/${encodeURIComponent(fileId)}`, { timeoutSec: 120 })
      return { data: unwrap(safeJson(file.text)), note: "task finished, file downloaded" }
    }
  }
  ctx.warn(`The task did not finish within ${waitSec}s. Read it later with "Tasks & files · Task by id" and this id.`)
  return { data: { ...last, taskId }, note: "task still running" }
}

/** The old behaviour, kept as its own button: GET every row of a CSV of endpoints. */
async function batchFromCsv(ctx: Parameters<ToolDef["run"]>[0], params: Params, session: Session) {
  const file = uploadedPath(params.urlFile)
  if (!file || !fs.existsSync(file)) { ctx.error("Upload a CSV with 'URL_Name' and 'Endpoint' columns first."); return }
  const { fields, rows } = parseCsv(fs.readFileSync(file, "utf8"))
  const nameCol = findCol(fields, "URL_Name", "name"), epCol = findCol(fields, "Endpoint", "url", "path")
  if (!nameCol || !epCol) { ctx.error("CSV must contain 'URL_Name' and 'Endpoint' columns."); return }
  const urls = rows.filter((r) => r[nameCol] && r[epCol]).slice(0, 500)
  if (!urls.length) { ctx.error("No valid URLs found in the file."); return }
  const columns = ["URL Name", "Endpoint", "Status", "Records", "Output File", "Response"]
  ctx.setColumns(columns)
  ctx.progress(0, urls.length)
  let ok = 0
  for (const r of urls) {
    ctx.checkStop()
    const endpoint = r[epCol]
    const key = ctx.addRow({ "URL Name": r[nameCol], Endpoint: endpoint, Status: "Running…", Records: "", "Output File": "", Response: "" })
    try {
      const res = await session.http.get(session.base + (endpoint.startsWith("/") ? "" : "/") + endpoint, { timeoutSec: 120 })
      const data = unwrap(safeJson(res.text))
      if (res.status === 200) {
        const out = path.join(ctx.runDir, `${safeName(r[nameCol], " _-")}_${stamp()}.json`)
        fs.writeFileSync(out, JSON.stringify(data, null, 2), "utf8")
        ctx.artifact(path.basename(out), out)
        ok++
        ctx.updateRow(key, { Status: "Success", Records: String(Array.isArray(data) ? data.length : 1), "Output File": out,
          Response: JSON.stringify(data).slice(0, 20000) })
      } else ctx.updateRow(key, { Status: `HTTP ${res.status}`, Response: res.text.slice(0, 20000) })
    } catch (e) {
      ctx.updateRow(key, { Status: "Request Error", Response: (e as Error).message })
    }
    ctx.step()
  }
  ctx.summary(`Total ${ok}/${urls.length}`)
  ctx.info("REST API calls have completed.")
}
