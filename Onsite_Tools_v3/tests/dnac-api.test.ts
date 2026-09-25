import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onsite-dnac-"))
// Point the app at a throw-away database BEFORE its modules load (settings fall back to defaults).
process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`
const { CATALOG_OPTIONS, cell, dnacRestApi, fileIdOf, fillPath, flattenObject, parseQuery, pathPlaceholders, taskIdOf, toRows } =
  await import("@/lib/tools/dnac-api")

describe("reading what the API gives back", () => {
  it("turns a list of records into a table, keeping every field it finds", () => {
    const { columns, rows } = toRows([
      { hostname: "SW1", managementIpAddress: "10.0.0.1" },
      { hostname: "SW2", managementIpAddress: "10.0.0.2", serialNumber: "FOC1" },
    ])
    expect(columns).toEqual(["hostname", "managementIpAddress", "serialNumber"])
    expect(rows[0]).toEqual({ hostname: "SW1", managementIpAddress: "10.0.0.1", serialNumber: "" })
    expect(rows[1].serialNumber).toBe("FOC1")
  })

  it("shows a single record as Field / Value, nested keys included", () => {
    const { columns, rows } = toRows({ hostname: "SW1", license: { name: "essentials", status: { valid: true } } })
    expect(columns).toEqual(["Field", "Value"])
    expect(rows).toEqual([
      { Field: "hostname", Value: "SW1" },
      { Field: "license.name", Value: "essentials" },
      { Field: "license.status.valid", Value: "true" },
    ])
  })

  it("never prints [object Object], and copes with counts, scalars and nothing at all", () => {
    expect(cell({ a: 1 })).toBe('{"a":1}')
    expect(cell(["a", "b"])).toBe('["a","b"]')
    expect(cell(null)).toBe("")
    expect(toRows(42)).toEqual({ columns: ["Value"], rows: [{ Value: "42" }] })
    expect(toRows(["a", "b"]).rows).toEqual([{ Value: "a" }, { Value: "b" }])
    expect(toRows([])).toEqual({ columns: [], rows: [] })
    expect(flattenObject({ response: 12 })).toEqual([{ Field: "response", Value: "12" }])
  })
})

describe("building the request", () => {
  it("reads key=value lines and ignores blanks and comments", () => {
    expect(parseQuery("hostname=SW-CORE-01\n\n# a note\nfamily=Switches and Hubs\nbad line")).toEqual({
      hostname: "SW-CORE-01", family: "Switches and Hubs",
    })
  })

  it("fills the {placeholder} in a catalog path", () => {
    expect(pathPlaceholders("/dna/intent/api/v1/network-device/{id}/config")).toEqual(["id"])
    expect(pathPlaceholders("/dna/intent/api/v1/network-device")).toEqual([])
    expect(fillPath("/dna/intent/api/v1/network-device/ip-address/{ip}", " 10.0.205.249 ")).toBe("/dna/intent/api/v1/network-device/ip-address/10.0.205.249")
  })

  it("offers a catalog where every entry carries its method and a real Catalyst Center path", () => {
    expect(CATALOG_OPTIONS[0].value).toBe("custom")
    for (const o of CATALOG_OPTIONS.slice(1)) expect(o.value, o.label).toMatch(/^(GET|POST|PUT|DELETE) \/dna\/(intent|data|system)\/api\/v\d\//)
    expect(CATALOG_OPTIONS.some((o) => o.value === "GET /dna/intent/api/v1/network-device")).toBe(true)
  })

  it("finds the id of the background job a write request started", () => {
    expect(taskIdOf({ response: { taskId: "t1" } })).toBe("t1")
    expect(taskIdOf({ response: { executionId: "e1" } })).toBe("e1")
    expect(taskIdOf({ response: {} })).toBe("")
    expect(fileIdOf('{"fileId":"f1"}')).toBe("f1")
    expect(fileIdOf("Command execution complete")).toBe("")
  })
})

/** A stand-in Catalyst Center: the token, a paged device list, and a task that produces a file. */
function fakeCatalystCenter(devices: number) {
  const seen: string[] = []
  let taskPolls = 0
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x")
    seen.push(`${req.method} ${url.pathname}${url.search}`)
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" })
      res.end(typeof body === "string" ? body : JSON.stringify(body))
    }
    if (url.pathname === "/dna/system/api/v1/auth/token") {
      const auth = Buffer.from((req.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString()
      return auth === "admin:secret" ? send(200, { Token: "TOK-1" }) : send(401, { error: "bad credentials" })
    }
    if (req.headers["x-auth-token"] !== "TOK-1") return send(401, { error: "no token" })

    if (url.pathname === "/dna/intent/api/v1/network-device") {
      const offset = Number(url.searchParams.get("offset") ?? "1") // 1-based, like the real thing
      const limit = Number(url.searchParams.get("limit") ?? "500")
      const page = Array.from({ length: Math.max(0, Math.min(limit, devices - offset + 1)) },
        (_, i) => ({ hostname: `SW-${offset + i}`, managementIpAddress: `10.0.0.${offset + i}` }))
      return send(200, { response: page, version: "1.0" })
    }
    if (url.pathname === "/dna/intent/api/v1/network-device-poller/cli/read-request") {
      return send(202, { response: { taskId: "task-1", url: "/dna/intent/api/v1/task/task-1" }, version: "1.0" })
    }
    if (url.pathname === "/dna/intent/api/v1/task/task-1") {
      taskPolls++
      return send(200, { response: taskPolls < 2 ? { id: "task-1", progress: "CLI Runner request creation" }
        : { id: "task-1", endTime: 123, progress: '{"fileId":"file-1"}' }, version: "1.0" })
    }
    if (url.pathname === "/dna/intent/api/v1/file/file-1") {
      return send(200, [{ deviceUuid: "uuid-1", commandResponses: { SUCCESS: { "show version": "Cisco IOS XE 17.9" } } }])
    }
    if (url.pathname === "/dna/intent/api/v1/network-device/count") return send(200, { response: devices })
    return send(404, { error: "no such endpoint" })
  })
  return new Promise<{ port: number; seen: string[]; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      port: (server.address() as { port: number }).port,
      seen,
      close: () => new Promise((r) => server.close(() => r())),
    }))
  })
}

type Row = Record<string, unknown>
function fakeCtx() {
  const rows: Row[] = []
  const messages: string[] = []
  let columns: string[] = []
  return {
    rows, messages, cols: () => columns,
    ctx: {
      addRow: (r: Row) => { rows.push(r); return String(rows.length) },
      updateRow: (key: string, patch: Row) => { rows[Number(key) - 1] = { ...rows[Number(key) - 1], ...patch } },
      setColumns: (c: string[]) => { columns = c },
      progress: () => undefined,
      step: () => undefined,
      checkStop: () => undefined,
      summary: (t: string) => messages.push(`summary: ${t}`),
      info: (t: string) => messages.push(`info: ${t}`),
      warn: (t: string) => messages.push(`warn: ${t}`),
      error: (t: string) => messages.push(`error: ${t}`),
      artifact: (name: string) => messages.push(`artifact: ${name}`),
      log: () => undefined,
      runDir: dir,
      stopRequested: false,
    },
  }
}

describe("DNAC REST API - end to end against a stand-in Catalyst Center", () => {
  let dnac: Awaited<ReturnType<typeof fakeCatalystCenter>>
  const login = () => ({ baseUrl: `http://127.0.0.1:${dnac.port}`, username: "admin", password: "secret", verifySsl: false })

  beforeAll(async () => { dnac = await fakeCatalystCenter(1200) })
  afterAll(async () => {
    await dnac?.close()
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* Windows keeps the SQLite file locked */ }
  })

  it("logs in, follows every page of a device list and lays it out as a table", async () => {
    const { rows, cols, messages, ctx } = fakeCtx()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dnacRestApi.run(ctx as any, { ...login(), api: "GET /dna/intent/api/v1/network-device", allPages: true, maxRows: 5000 })

    expect(rows).toHaveLength(1200)
    expect(cols()).toEqual(["hostname", "managementIpAddress"])
    expect(rows[0]).toEqual({ hostname: "SW-1", managementIpAddress: "10.0.0.1" })
    expect(rows.at(-1)).toEqual({ hostname: "SW-1200", managementIpAddress: "10.0.0.1200" })
    // offset is 1-based and the page size is the documented maximum.
    const listed = dnac.seen.filter((s) => s.includes("/network-device?"))
    expect(listed).toEqual([
      "GET /dna/intent/api/v1/network-device?offset=1&limit=500",
      "GET /dna/intent/api/v1/network-device?offset=501&limit=500",
      "GET /dna/intent/api/v1/network-device?offset=1001&limit=500",
    ])
    expect(messages).toContain("summary: 1200 record(s) · 3 page(s)")
    expect(messages.some((m) => m.startsWith("artifact: "))).toBe(true)
  })

  it("stops where the person asked it to stop", async () => {
    const { rows, messages, ctx } = fakeCtx()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dnacRestApi.run(ctx as any, { ...login(), api: "GET /dna/intent/api/v1/network-device", allPages: true, maxRows: 10 })
    expect(rows).toHaveLength(10)
    expect(messages.join()).not.toContain("error:")
  })

  it("sends the query lines as query parameters and reads a single record as Field / Value", async () => {
    const { rows, cols, ctx } = fakeCtx()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dnacRestApi.run(ctx as any, { ...login(), api: "GET /dna/intent/api/v1/network-device/count" })
    expect(cols()).toEqual(["Value"])
    expect(rows).toEqual([{ Value: "1200" }])

    const second = fakeCtx()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dnacRestApi.run(second.ctx as any, { ...login(), api: "GET /dna/intent/api/v1/network-device", allPages: false,
      query: "hostname=SW-7\n# comment" })
    expect(dnac.seen.at(-1)).toBe("GET /dna/intent/api/v1/network-device?hostname=SW-7")
  })

  it("follows the task a POST starts and downloads the file it produced", async () => {
    const { rows, messages, ctx } = fakeCtx()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dnacRestApi.run(ctx as any, {
      ...login(),
      api: "POST /dna/intent/api/v1/network-device-poller/cli/read-request",
      body: '{"commands":["show version"],"deviceUuids":["uuid-1"]}',
      waitForTask: true, taskWait: 30,
    })
    expect(messages.join(" | "), JSON.stringify(rows)).toMatch(/Task task-1 started/)
    expect(rows).toHaveLength(1)
    expect(String(rows[0].commandResponses)).toContain("Cisco IOS XE 17.9")
    expect(dnac.seen.filter((s) => s.includes("/task/task-1")).length).toBeGreaterThanOrEqual(2)
    expect(dnac.seen).toContain("GET /dna/intent/api/v1/file/file-1")
  })

  it("says what went wrong instead of throwing", async () => {
    const bad = fakeCtx()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dnacRestApi.run(bad.ctx as any, { ...login(), password: "wrong", api: "GET /dna/intent/api/v1/network-device" })
    expect(bad.messages.join()).toMatch(/Authentication failed/)

    const missing = fakeCtx()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dnacRestApi.run(missing.ctx as any, { ...login(), api: "custom", method: "GET", path: "/dna/intent/api/v1/nope" })
    expect(missing.rows[0]).toEqual({ Field: "HTTP status", Value: "404" })

    const needsId = fakeCtx()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dnacRestApi.run(needsId.ctx as any, { ...login(), api: "GET /dna/intent/api/v1/network-device/{id}" })
    expect(needsId.messages.join()).toMatch(/needs a value for \{id\}/)
    expect(needsId.rows).toHaveLength(0)
  })
})
