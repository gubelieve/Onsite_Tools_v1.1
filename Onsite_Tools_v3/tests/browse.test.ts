import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { POST } from "@/app/api/browse/route"

const call = (headers: Record<string, string>, body: unknown = { kind: "file" }) =>
  POST(new Request("http://127.0.0.1:8090/api/browse", { method: "POST", headers, body: JSON.stringify(body) }))

// Only the refusal paths are exercised: a request that passes the guard would open a real dialog.
describe("/api/browse guard", () => {
  it("refuses a browser on another PC (--lan), where the dialog would open on the wrong screen", async () => {
    const cases: Record<string, string>[] = [
      { host: "192.168.9.30:8090" },
      { host: "127.0.0.1:8090", "x-forwarded-for": "192.168.9.77" },
      { host: "onsite-tools.local:8090" },
    ]
    for (const headers of cases) {
      const res = await call(headers)
      expect(res.status, JSON.stringify(headers)).toBe(403)
      expect((await res.json()).error).toMatch(/Paste the path/)
    }
  })
})

describe("browse.ps1", () => {
  const script = fs.readFileSync(path.join(process.cwd(), "scripts", "browse.ps1"), "utf8")

  it("is shipped next to the app so the route can find it", () => {
    expect(script.length).toBeGreaterThan(500)
  })

  it("forces the dialog to the foreground - the web server is not the active app", () => {
    // Showing an owner window is what the dialog is anchored to; AttachThreadInput is what gets around
    // Windows' foreground lock. Without either one the dialog opens behind the browser.
    expect(script).toContain("$owner.Show()")
    expect(script).toContain("AttachThreadInput")
    expect(script).toContain("SetForegroundWindow")
    expect(script).toMatch(/TopMost\s*=\s*\$true/)
    expect(script).toContain("[OnsiteFg]::Force($owner.Handle)")
  })

  it("takes every caller-supplied string from the environment, never from script text", () => {
    for (const name of ["ONSITE_TITLE", "ONSITE_FILTER", "ONSITE_KIND", "ONSITE_INITIAL"]) {
      expect(script).toContain(`$env:${name}`)
    }
    expect(script).not.toMatch(/Invoke-Expression|iex\b/)
  })
})
