import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { startFakeDevice, type FakeDevice } from "./fake-device"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onsite-upgrade-"))
// Point the app at a throw-away database BEFORE its modules load (settings fall back to defaults).
process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`
const image = path.join(dir, "cat9k_lite iosxe.17.09.05.bin")
const payload = crypto.randomBytes(1024 * 1024 + 7)
fs.writeFileSync(image, payload)

type Row = Record<string, unknown>
function fakeCtx() {
  const rows: Row[] = []
  const ctx = {
    addRow: (r: Row) => { rows.push(r); return String(rows.length) },
    // Same contract as JobContext: the key is the row, and a patch merges into it.
    updateRow: (key: string, patch: Row) => { rows[Number(key) - 1] = { ...rows[Number(key) - 1], ...patch } },
    progress: () => undefined,
    log: () => undefined,
    runDir: dir,
    stopRequested: false,
  }
  return { rows, ctx }
}

describe("IOS Upgrade stage 1 - built-in FTP, end to end", () => {
  let dev: FakeDevice
  afterAll(async () => {
    await dev?.close()
    // Windows keeps the SQLite file locked until the process exits - leaving a temp folder behind is fine.
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  beforeAll(async () => { dev = await startFakeDevice() })

  it("starts its own FTP server, lets the device copy the image and hides the one-time password", async () => {
    const { SingleFileFtpServer } = await import("@/lib/net/ftp-server")
    const { Stage, flashName } = await import("@/lib/tools/upgrade-ios")
    const ftp = new SingleFileFtpServer(image, flashName(image)) // published without the space / underscore
    await ftp.start(0, "127.0.0.1")
    await dev.close()
    dev = await startFakeDevice({ ftpPort: ftp.port }) // the fake switch dials the FTP port of this run

    const { rows, ctx } = fakeCtx()
    const device = { host: `127.0.0.1:${dev.port}`, site: "LAB", deviceType: "cisco_ios", hostname: "", description: "", raw: {} }
    const params = { username: "admin", password: "secret", transferMethod: "ftp-builtin", deviceType: "cisco_ios" }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await new Stage(ctx as any, params, device, 1, image, "127.0.0.1", ftp).run()
    await ftp.stop()

    // The transfer is ONE row that keeps being updated - not a new "Uploading…" line every few seconds.
    expect(rows, JSON.stringify(rows, null, 1)).toHaveLength(1)
    const last = rows.at(-1)!
    expect(last.Status, JSON.stringify(rows, null, 1)).toBe("Completed")
    expect(last.Message).toContain("built-in FTP")
    expect(last.Progress).toBe("100.0") // the bar in the results table ends full
    expect(last["Bytes Transferred"]).toBe(String(payload.length))
    const name = flashName(image)
    expect(name).toBe("cat9k-lite-iosxe.17.09.05.bin")
    expect(dev.flash.get(name)?.equals(payload)).toBe(true) // the device really received the image
    expect(JSON.stringify(rows)).not.toContain(ftp.password) // results and logs never show the FTP password
    expect(fs.readdirSync(dir).filter((f) => f.startsWith("stage_1")).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("")).not.toContain(ftp.password)
  })

  it("reports a failed copy when the device cannot reach the FTP server", async () => {
    const { SingleFileFtpServer } = await import("@/lib/net/ftp-server")
    const { Stage } = await import("@/lib/tools/upgrade-ios")
    const ftp = new SingleFileFtpServer(image) // never started -> the device's connection is refused
    await dev.close()
    dev = await startFakeDevice({ ftpPort: 1 })
    const { rows, ctx } = fakeCtx()
    const device = { host: `127.0.0.1:${dev.port}`, site: "LAB", deviceType: "cisco_ios", hostname: "", description: "", raw: {} }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await new Stage(ctx as any, { username: "admin", password: "secret", transferMethod: "ftp-builtin" }, device, 1, image, "127.0.0.1", ftp).run()
    expect(rows).toHaveLength(1) // the failure replaces the running row instead of piling up
    expect(rows.at(-1)!.Status).toBe("Failed")
    expect(String(rows.at(-1)!.Message)).toMatch(/firewall|reach/i)
  })
})
