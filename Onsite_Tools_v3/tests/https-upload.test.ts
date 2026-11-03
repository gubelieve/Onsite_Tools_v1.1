import crypto from "node:crypto"
import fs from "node:fs"
import https from "node:https"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { startFakeDevice, type FakeDevice } from "./fake-device"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onsite-https-"))
// Point the app at a throw-away database BEFORE its modules load (settings fall back to defaults).
process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`
const image = path.join(dir, "cat9k_iosxe.17.12.04.bin")
const payload = crypto.randomBytes(512 * 1024 + 3)
fs.writeFileSync(image, payload)

type Row = Record<string, unknown>
function fakeCtx() {
  const rows: Row[] = []
  const ctx = {
    addRow: (r: Row) => { rows.push(r); return String(rows.length) },
    updateRow: (key: string, patch: Row) => { rows[Number(key) - 1] = { ...rows[Number(key) - 1], ...patch } },
    progress: () => undefined,
    log: () => undefined,
    runDir: dir,
    stopRequested: false,
  }
  return { rows, ctx }
}

/** GET from the built-in server the way a client that does not check the certificate would. */
function get(port: number, file: string, auth?: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: Buffer; headers: Record<string, unknown> }>((resolve, reject) => {
    https.get({ host: "127.0.0.1", port, path: `/${file}`, rejectUnauthorized: false, auth, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on("data", (c: Buffer) => chunks.push(c))
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), headers: res.headers }))
    }).on("error", reject)
  })
}

afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* Windows keeps the db locked */ } })

describe("self-signed certificate for the built-in HTTPS server", () => {
  it("is a valid, self-signed CA certificate for the addresses it was made for", async () => {
    const { makeSelfSigned } = await import("@/lib/net/self-signed")
    const made = makeSelfSigned(["10.20.30.40", "127.0.0.1"])
    const x = new crypto.X509Certificate(made.cert)
    expect(x.verify(x.publicKey)).toBe(true) // signed with its own key
    expect(x.ca).toBe(true) // "crypto pki authenticate" takes it as a root
    expect(x.checkIP("10.20.30.40")).toBe("10.20.30.40")
    expect(x.checkIP("10.20.30.41")).toBeUndefined()
    expect(x.subject).toContain("CN=10.20.30.40")
    expect(x.checkPrivateKey(crypto.createPrivateKey(made.key))).toBe(true)
    expect(new Date(x.validTo).getFullYear()).toBeGreaterThanOrEqual(new Date().getFullYear() + 9)
  })

  it("is kept and reused while it covers the address, and remade when it does not", async () => {
    const { serverCert } = await import("@/lib/net/self-signed")
    const where = path.join(dir, "certs")
    const first = serverCert("127.0.0.1", where)
    expect(serverCert("127.0.0.1", where).fingerprint).toBe(first.fingerprint)
    const moved = serverCert("192.0.2.77", where)
    expect(moved.fingerprint).not.toBe(first.fingerprint)
    expect(moved.x509.checkIP("192.0.2.77")).toBe("192.0.2.77")
  })
})

describe("built-in HTTPS server", () => {
  it("serves only the one file, only with the one-time login, and answers Range requests", async () => {
    const { SingleFileHttpsServer } = await import("@/lib/net/https-server")
    const { serverCert } = await import("@/lib/net/self-signed")
    const srv = new SingleFileHttpsServer(image, serverCert("127.0.0.1", path.join(dir, "certs")), "ios.bin")
    await srv.start(0, "127.0.0.1")
    try {
      expect((await get(srv.port, "ios.bin")).status).toBe(401)
      expect((await get(srv.port, "ios.bin", "onsite:wrong")).status).toBe(401)
      const login = `${srv.user}:${srv.password}`
      expect((await get(srv.port, "other.bin", login)).status).toBe(404)
      expect((await get(srv.port, "../data/onsite.db", login)).status).toBe(404)
      const full = await get(srv.port, "ios.bin", login)
      expect(full.status).toBe(200)
      expect(full.body.equals(payload)).toBe(true)
      const part = await get(srv.port, "ios.bin", login, { Range: "bytes=100-199" })
      expect(part.status).toBe(206)
      expect(part.body.equals(payload.subarray(100, 200))).toBe(true)
      expect(srv.transfers.get("127.0.0.1")?.sent).toBe(200)
    } finally { await srv.stop() }
  })
})

describe("IOS Upgrade stage 1 - built-in HTTPS, end to end", () => {
  let dev: FakeDevice
  beforeAll(async () => { dev = await startFakeDevice() })
  afterAll(async () => { await dev?.close() })
  const device = () => ({ host: `127.0.0.1:${dev.port}`, site: "LAB", deviceType: "cisco_ios", hostname: "", description: "", raw: {} })

  const runStage1 = async (httpsTrust: boolean) => {
    const { SingleFileHttpsServer } = await import("@/lib/net/https-server")
    const { serverCert } = await import("@/lib/net/self-signed")
    const { Stage, flashName } = await import("@/lib/tools/upgrade-ios")
    const srv = new SingleFileHttpsServer(image, serverCert("127.0.0.1", path.join(dir, "certs")), flashName(image))
    await srv.start(0, "127.0.0.1")
    const { rows, ctx } = fakeCtx()
    const params = { username: "admin", password: "secret", transferMethod: "https-builtin", httpsTrust }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await new Stage(ctx as any, params, device(), 1, image, "127.0.0.1", srv).run()
    } finally { await srv.stop() }
    return { rows, srv, name: flashName(image) }
  }

  it("fails with a certificate explanation when the device does not trust this PC", async () => {
    const { rows } = await runStage1(false)
    expect(rows.at(-1)!.Status, JSON.stringify(rows, null, 1)).toBe("Failed")
    expect(String(rows.at(-1)!.Message)).toMatch(/certificate/i)
    expect(dev.trustpoints.size).toBe(0)
  }, 30_000)

  it("installs this PC's certificate as a trustpoint, then copies the image and hides the password", async () => {
    const { trustpointName } = await import("@/lib/tools/upgrade-ios")
    const { rows, srv, name } = await runStage1(true)
    const last = rows.at(-1)!
    expect(last.Status, JSON.stringify(rows, null, 1)).toBe("Completed")
    expect(last.Message).toContain("built-in HTTPS")
    expect(last.Progress).toBe("100.0")
    expect(dev.trustpoints.get(trustpointName(srv.certificate.fingerprint))).toBe(srv.certificate.cert.trim() + "\n")
    expect(rows.some((r) => String(r.Message).includes("trustpoint ONSITE-"))).toBe(true)
    expect(dev.flash.get(name)?.equals(payload)).toBe(true) // the device really received the image
    expect(dev.commands.some((c) => c.startsWith("copy https://onsite:"))).toBe(true)
    expect(JSON.stringify(rows)).not.toContain(srv.password)
    const logs = fs.readdirSync(dir).filter((f) => f.startsWith("stage_1")).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("")
    expect(logs).not.toContain(srv.password)
  }, 60_000) // the trustpoint paste waits for the device to go quiet after every line
})
