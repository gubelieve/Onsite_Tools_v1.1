import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { startFakeDevice, type FakeDevice } from "./fake-device"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onsite-cleanup-"))
// Point the app at a throw-away database BEFORE its modules load (settings fall back to defaults).
process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`
const { Stage, parseInactiveFiles } = await import("@/lib/tools/upgrade-ios")

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

const device = (port: number) => ({ host: `127.0.0.1:${port}`, site: "LAB", deviceType: "cisco_ios", hostname: "", description: "", raw: {} })
const CREDS = { username: "admin", password: "secret" }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const runStage = (ctx: unknown, port: number, stage: number) => new Stage(ctx as any, CREDS, device(port), stage, "", "127.0.0.1").run()

const SINGLE = `install remove inactive
install_remove: START Sat Sep 21 09:55:11 UTC 2026
Cleaning up unnecessary package files
  Scanning boot directory for packages ... done.
  Preparing packages list to delete ...
    cat9k-espbase.17.09.04a.SPA.pkg
      File is in use, will not delete.
    packages.conf
      File is in use, will not delete.
  done.

The following files will be deleted:
[switch 1]:
/flash/cat9k-cc_srdriver.16.12.05b.SPA.pkg
/flash/cat9k-espbase.16.12.05b.SPA.pkg
/flash/cat9k_iosxe.16.12.05b.SPA.bin

Do you want to remove the above files? [y/n]`

describe("install remove inactive - reading the device's list", () => {
  it("takes the files the device offers to delete, and nothing else", () => {
    expect(parseInactiveFiles(SINGLE)).toEqual([
      "switch 1: /flash/cat9k-cc_srdriver.16.12.05b.SPA.pkg",
      "switch 1: /flash/cat9k-espbase.16.12.05b.SPA.pkg",
      "switch 1: /flash/cat9k_iosxe.16.12.05b.SPA.bin",
    ])
    // The "File is in use, will not delete" block above the list must never be read as a file to delete.
    expect(parseInactiveFiles(SINGLE).join()).not.toContain("17.09.04a")
  })

  it("keeps the two members of a stack apart", () => {
    const files = parseInactiveFiles(`The following files will be deleted:
[switch 1]:
/flash/cat9k-rpbase.16.12.05b.SPA.pkg
[switch 2]:
/flash/cat9k-rpbase.16.12.05b.SPA.pkg
bootflash:old.bin

Do you want to remove the above files? [y/n]`)
    expect(files).toEqual([
      "switch 1: /flash/cat9k-rpbase.16.12.05b.SPA.pkg",
      "switch 2: /flash/cat9k-rpbase.16.12.05b.SPA.pkg",
      "switch 2: bootflash:old.bin",
    ])
  })

  it("finds nothing when there is nothing to clean, or when the command was refused", () => {
    expect(parseInactiveFiles("SUCCESS: No extra package or provisioning files found on media. Nothing to clean.")).toEqual([])
    expect(parseInactiveFiles("The following files will be deleted:\n[switch 1]:\n\nSUCCESS: Nothing to clean.")).toEqual([])
    expect(parseInactiveFiles("% Invalid input detected at '^' marker.")).toEqual([])
  })
})

describe("install remove inactive - end to end against the fake device", () => {
  let dev: FakeDevice
  beforeAll(async () => { dev = await startFakeDevice() })
  afterAll(async () => {
    await dev?.close()
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* Windows keeps the SQLite file locked */ }
  })

  it("lists every file that would go, and deletes nothing", async () => {
    const { rows, ctx } = fakeCtx()
    await runStage(ctx, dev.port, 6)

    const listed = rows.filter((r) => r.Status === "Will be deleted").map((r) => r.Message)
    expect(listed, JSON.stringify(rows, null, 1)).toEqual([
      "switch 1: /flash/cat9k-cc_srdriver.16.12.05b.SPA.pkg",
      "switch 1: /flash/cat9k-espbase.16.12.05b.SPA.pkg",
      "switch 1: /flash/cat9k_iosxe.16.12.05b.SPA.bin",
    ])
    expect(rows.at(-1)).toMatchObject({ Stage: "Cleanup (list)", Status: "Completed" })
    expect(String(rows.at(-1)!.Message)).toContain("3 file(s) can be deleted")
    expect(dev.commands).toContain("install remove inactive")
    expect(dev.commands.at(-1)).toBe("n")      // the question was answered with no
    expect(dev.inactive).toHaveLength(3)       // and the files are still there
  })

  it("deletes them once the run that asks for it is started, and reports the space freed", async () => {
    const { rows, ctx } = fakeCtx()
    await runStage(ctx, dev.port, 7)

    expect(rows.filter((r) => r.Status === "Deleting")).toHaveLength(3)
    const last = rows.at(-1)!
    expect(last, JSON.stringify(rows, null, 1)).toMatchObject({ Stage: "Cleanup (remove)", Status: "Completed" })
    expect(String(last.Message)).toContain("3 file(s) deleted")
    expect(String(last.Message)).toContain("60.0MB freed")
    expect(Number(last["Bytes Transferred"])).toBe(60 * 1024 * 1024)
    expect(dev.commands).toContain("y")
    expect(dev.inactive).toHaveLength(0)
  })

  it("says so plainly when there is nothing left to clean", async () => {
    const { rows, ctx } = fakeCtx()
    await runStage(ctx, dev.port, 6)
    expect(rows.at(-1)).toMatchObject({ Status: "Completed" })
    expect(String(rows.at(-1)!.Message)).toContain("Nothing to clean up")
    expect(rows.some((r) => r.Status === "Will be deleted")).toBe(false)
  })

  it("explains itself on a device in bundle mode, where the command does not exist", async () => {
    const bundle = await startFakeDevice({ noInstallCommand: true })
    try {
      const { rows, ctx } = fakeCtx()
      await runStage(ctx, bundle.port, 7)
      const last = rows.at(-1)!
      expect(last.Status, JSON.stringify(rows, null, 1)).toBe("Failed")
      expect(String(last.Message)).toContain("install mode")
      expect(String(last.Message)).toContain("delete flash:")
      expect(bundle.commands).not.toContain("y") // nothing was confirmed on a device that never asked
    } finally { await bundle.close() }
  })
})
