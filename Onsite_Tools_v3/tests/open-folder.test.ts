import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onsite-open-"))
process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`
const { POST } = await import("@/app/api/open-folder/route")

const call = (headers: Record<string, string>, body: unknown) =>
  POST(new Request("http://127.0.0.1:8090/api/open-folder", { method: "POST", headers, body: JSON.stringify(body) }))
const local = { host: "127.0.0.1:8090" }

// Only the refusal paths are exercised: a request that passes the guard would open a real Explorer window.
describe("/api/open-folder guard", () => {
  it("refuses a browser on another PC (--lan), where the window would open on the wrong screen", async () => {
    const cases: Record<string, string>[] = [{ host: "192.168.9.30:8090" }, { host: "127.0.0.1:8090", "x-forwarded-for": "192.168.9.77" }]
    for (const headers of cases) {
      const res = await call(headers, { toolId: "config-devices" })
      expect(res.status, JSON.stringify(headers)).toBe(403)
      expect((await res.json()).error).toMatch(/Zip log files/)
    }
  })

  it("takes a job or a known tool, never a path", async () => {
    expect((await call(local, { path: "C:\\Windows" })).status).toBe(400)
    expect((await call(local, { toolId: "..\\..\\Windows" })).status).toBe(400)
    expect((await call(local, { toolId: "no-such-tool" })).status).toBe(400)
    expect((await call(local, { jobId: "no-such-job" })).status).toBe(404)
  })
})
