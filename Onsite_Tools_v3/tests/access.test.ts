import { afterEach, describe, expect, it } from "vitest"
import { NextRequest } from "next/server"
import { decideAccess, keyPage, sameKey } from "@/lib/access"
import { proxy } from "@/proxy"

const KEY = "s3cret-key_123"
const u = (s: string) => new URL(s, "http://192.168.9.30:8090")

describe("LAN access key", () => {
  it("lets everything through when no key is set (127.0.0.1 mode)", () => {
    expect(decideAccess(u("/api/jobs"), undefined, "")).toEqual({ kind: "allow" })
  })

  it("refuses a request without the key, as JSON for the API and as a page otherwise", () => {
    expect(decideAccess(u("/api/tools/config-devices/run"), undefined, KEY)).toEqual({ kind: "deny", api: true })
    expect(decideAccess(u("/tools/upgrade-ios"), "wrong", KEY)).toEqual({ kind: "deny", api: false })
  })

  it("takes the key from the link once, then from the cookie", () => {
    const d = decideAccess(u("/tools/x?key=" + KEY + "&a=1"), undefined, KEY)
    expect(d.kind).toBe("remember")
    if (d.kind === "remember") expect(d.cleanUrl.search).toBe("?a=1")
    expect(decideAccess(u("/tools/x"), KEY, KEY)).toEqual({ kind: "allow" })
  })

  it("ignores Host and X-Forwarded-For - a spoofed 127.0.0.1 is still refused", () => {
    expect(decideAccess(new URL("http://127.0.0.1:8090/api/jobs"), undefined, KEY).kind).toBe("deny")
  })

  it("compares keys of any length without throwing", () => {
    expect(sameKey("a", KEY)).toBe(false)
    expect(sameKey("", KEY)).toBe(false)
    expect(sameKey(KEY, KEY)).toBe(true)
  })

  it("escapes the path it echoes into the key page", () => {
    expect(keyPage('/"><script>x</script>', false)).not.toContain("<script>x")
  })
})

describe("proxy", () => {
  afterEach(() => { delete process.env.ONSITE_ACCESS_KEY })

  it("sets an http-only cookie and strips the key from the URL", () => {
    process.env.ONSITE_ACCESS_KEY = KEY
    const res = proxy(new NextRequest("http://192.168.9.30:8090/?key=" + KEY))
    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toBe("http://192.168.9.30:8090/")
    expect(res.headers.get("set-cookie")).toMatch(/onsite_key=.*HttpOnly/i)
  })

  it("answers 401 to an API call without the cookie", async () => {
    process.env.ONSITE_ACCESS_KEY = KEY
    const res = proxy(new NextRequest("http://192.168.9.30:8090/api/jobs", { headers: { host: "127.0.0.1:8090" } }))
    expect(res.status).toBe(401)
  })
})
