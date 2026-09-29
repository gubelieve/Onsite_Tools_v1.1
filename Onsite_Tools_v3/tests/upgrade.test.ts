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

describe("Stage 0 / Stage 5 capture, for comparing before with after", () => {
  let box: FakeDevice
  // Its own device, folder and image: the suite above deletes its temp folder when it finishes.
  const own = fs.mkdtempSync(path.join(os.tmpdir(), "onsite-capture-"))
  const ownImage = path.join(own, "image.bin")
  const ownCtx = () => {
    const rows: Record<string, unknown>[] = []
    return { rows, ctx: { addRow: (r: Record<string, unknown>) => { rows.push(r); return String(rows.length) },
      updateRow: () => undefined, progress: () => undefined, log: () => undefined, runDir: own, stopRequested: false } }
  }
  const device = () => ({ host: `127.0.0.1:${box.port}`, site: "LAB", deviceType: "cisco_ios", hostname: "", description: "", raw: {} })

  beforeAll(async () => { fs.writeFileSync(ownImage, Buffer.alloc(1024)); box = await startFakeDevice() })
  afterAll(async () => { await box?.close(); try { fs.rmSync(own, { recursive: true, force: true }) } catch { /* ignore */ } })

  it("writes a log Compare Configuration can read, in the folder it expects", async () => {
    const { Stage, DEFAULT_CAPTURE } = await import("@/lib/tools/upgrade-ios")
    const { byCommand, splitSections } = await import("@/lib/tools/compare-config")
    const { infoFromLogName } = await import("@/lib/tools/parsers")

    const { rows, ctx } = ownCtx()
    const params = { username: "admin", password: "secret", captureCommands: ["show version", "show clock", "show bad"].join("\n") }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await new Stage(ctx as any, params, device(), 0, ownImage, "127.0.0.1").run()

    const captured = rows.find((r) => String(r.Message).includes("Captured"))
    expect(captured, JSON.stringify(rows.map((r) => r.Message), null, 1)).toBeTruthy()
    expect(String(captured!.Message)).toContain("into before/")
    const file = String(captured!.Output)
    expect(file).toContain(`${path.sep}before${path.sep}`)

    // The file name is what Compare Configuration matches devices by...
    expect(infoFromLogName(path.basename(file)).ip).toBe("127.0.0.1")
    // ...and the contents split into the same command sections.
    const sections = byCommand(splitSections(fs.readFileSync(file, "utf8")))
    expect([...sections.keys()]).toEqual(["(whole file)", "show version", "show clock", "show bad"])
    expect(sections.get("show version")).toContain("Cisco IOS XE Software")
    expect(sections.get("(whole file)")).toContain("[Command List]")
    expect(DEFAULT_CAPTURE).toContain("show run")
  })

  it("writes Stage 5 into after/, beside the before/ of the same session", async () => {
    const { Stage } = await import("@/lib/tools/upgrade-ios")
    const { rows, ctx } = ownCtx()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await new Stage(ctx as any, { username: "admin", password: "secret", captureCommands: "show version" }, device(), 5, ownImage, "127.0.0.1").run()
    const captured = rows.find((r) => String(r.Message).includes("Captured"))
    expect(String(captured?.Message)).toContain("into after/")
    expect(fs.readdirSync(path.join(own, "after"))).toHaveLength(1)
    expect(fs.existsSync(path.join(own, "before"))).toBe(true) // the pair Compare Configuration needs
  })

  it("captures nothing when the list is emptied, and never fails the stage over it", async () => {
    const { Stage } = await import("@/lib/tools/upgrade-ios")
    const { rows, ctx } = ownCtx()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await new Stage(ctx as any, { username: "admin", password: "secret", captureCommands: ["  ", " ", ""].join("\n") }, device(), 0, ownImage, "127.0.0.1").run()
    expect(rows.some((r) => String(r.Message).includes("Captured"))).toBe(false)
    expect(rows.at(-1)!.Status).toBe("Completed")
  })
})

describe("capture commands per Device Category", () => {
  it("gives each category its own list and falls back for the rest", async () => {
    const { commandsForCategory } = await import("@/lib/tools/types")
    const { ANY_CATEGORY } = await import("@/lib/tools/types")
    const value = {
      [ANY_CATEGORY]: "show version\nshow run",
      WLC: "show ap summary\nshow wlan summary",
      CORE: "  \n ", // filled in and then cleared - still means "use the default"
    }
    expect(commandsForCategory(value, "WLC")).toEqual(["show ap summary", "show wlan summary"])
    expect(commandsForCategory(value, "SS")).toEqual(["show version", "show run"])   // no list of its own
    expect(commandsForCategory(value, "CORE")).toEqual(["show version", "show run"]) // blank list of its own
    expect(commandsForCategory(value, "")).toEqual(["show version", "show run"])     // device with no category
  })

  it("still understands the single list the field used to hold, and an empty one", async () => {
    const { commandsForCategory } = await import("@/lib/tools/types")
    expect(commandsForCategory("show version\n\nshow run ", "WLC")).toEqual(["show version", "show run"])
    expect(commandsForCategory({}, "WLC")).toEqual([])
    expect(commandsForCategory(undefined, "WLC")).toEqual([])
  })

  it("captures what the device's own category asks for", async () => {
    const { Stage } = await import("@/lib/tools/upgrade-ios")
    const { ANY_CATEGORY } = await import("@/lib/tools/types")
    const { byCommand, splitSections } = await import("@/lib/tools/compare-config")
    const own = fs.mkdtempSync(path.join(os.tmpdir(), "onsite-percat-"))
    const image = path.join(own, "image.bin")
    fs.writeFileSync(image, Buffer.alloc(1024))
    const box = await startFakeDevice()
    try {
      const rows: Record<string, unknown>[] = []
      const ctx = { addRow: (r: Record<string, unknown>) => { rows.push(r); return String(rows.length) },
        updateRow: () => undefined, progress: () => undefined, log: () => undefined, runDir: own, stopRequested: false }
      const device = { host: `127.0.0.1:${box.port}`, site: "WLC", deviceType: "cisco_ios", hostname: "", description: "", raw: {} }
      const params = { username: "admin", password: "secret", captureCommands: { [ANY_CATEGORY]: "show version", WLC: "show clock" } }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await new Stage(ctx as any, params, device, 0, image, "127.0.0.1").run()

      const file = String(rows.find((r) => String(r.Message).includes("Captured"))!.Output)
      const sections = byCommand(splitSections(fs.readFileSync(file, "utf8")))
      expect([...sections.keys()]).toEqual(["(whole file)", "show clock"]) // the WLC list, not the default one
    } finally {
      await box.close()
      fs.rmSync(own, { recursive: true, force: true })
    }
  })
})

describe("install mode driven by hand, one step per button", () => {
  let box: FakeDevice
  const own = fs.mkdtempSync(path.join(os.tmpdir(), "onsite-manual-"))
  const image = path.join(own, "cat9k_iosxe.17.15.05.SPA.bin")
  const ctxOf = () => {
    const rows: Record<string, unknown>[] = []
    return { rows, ctx: { addRow: (r: Record<string, unknown>) => { rows.push(r); return String(rows.length) },
      updateRow: () => undefined, progress: () => undefined, log: () => undefined, runDir: own, stopRequested: false } }
  }
  const device = () => ({ host: `127.0.0.1:${box.port}`, site: "LAB", deviceType: "cisco_ios", hostname: "", description: "", raw: {} })
  const creds = { username: "admin", password: "secret", installMethod: "install", installStyle: "manual" }

  beforeAll(async () => { fs.writeFileSync(image, Buffer.alloc(512)); box = await startFakeDevice() })
  afterAll(async () => { await box?.close(); fs.rmSync(own, { recursive: true, force: true }) })

  it("runs exactly one command per step, in order, and nothing else", async () => {
    const { Stage } = await import("@/lib/tools/upgrade-ios")
    const say: string[] = []
    for (const stage of [8, 9, 10, 11]) {
      const { rows, ctx } = ctxOf()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await new Stage(ctx as any, creds, device(), stage, image, "127.0.0.1").run()
      say.push(`${rows.at(-1)!.Stage}: ${rows.at(-1)!.Status}`)
    }
    expect(say).toEqual(["Stage 3a: Completed", "Stage 3b: Completed", "Stage 3c: Completed", "Stage 3d: Completed"])
    expect(box.commands).toContain("boot system switch all flash:packages.conf")
    expect(box.installed).toEqual([
      "install add file flash:cat9k-iosxe.17.15.05.SPA.bin", // the flash name, not the Windows path
      "install activate prompt-level none",
      "install commit",
    ])
    // The one-shot command must not appear anywhere in a manual run.
    expect(box.commands.some((c) => c.includes("activate commit"))).toBe(false)
  })

  it("warns that an activate without a commit rolls back", async () => {
    const { Stage } = await import("@/lib/tools/upgrade-ios")
    const { rows, ctx } = ctxOf()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await new Stage(ctx as any, creds, device(), 10, image, "127.0.0.1").run()
    expect(String(rows.at(-1)!.Message)).toMatch(/commit/i)
    expect(String(rows.at(-1)!.Message)).toMatch(/rolls back/i)
  })

  it("still does the whole thing in one command when the mode is one-shot", async () => {
    const { Stage } = await import("@/lib/tools/upgrade-ios")
    const { rows, ctx } = ctxOf()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await new Stage(ctx as any, { ...creds, installStyle: "one-shot" }, device(), 3, image, "127.0.0.1").run()
    expect(rows.at(-1)!.Status).toBe("Completed")
    expect(box.commands).toContain("install add file flash:cat9k-iosxe.17.15.05.SPA.bin activate commit prompt-level none")
  })
})
