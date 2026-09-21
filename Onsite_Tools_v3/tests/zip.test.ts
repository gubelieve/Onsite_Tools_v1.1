import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import zlib from "node:zlib"
import { describe, expect, it } from "vitest"
import { crc32, folderEntries, zipBuffer } from "@/lib/zip"

/** Read a zip back the way a real unzipper does: central directory first, then each local header. */
function unzip(zip: Buffer): Record<string, string> {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  expect(eocd).toBeGreaterThan(-1)
  const count = zip.readUInt16LE(eocd + 10)
  let p = zip.readUInt32LE(eocd + 16)
  const out: Record<string, string> = {}
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(p)).toBe(0x02014b50)
    const method = zip.readUInt16LE(p + 10)
    const crc = zip.readUInt32LE(p + 16)
    const csize = zip.readUInt32LE(p + 20)
    const nameLen = zip.readUInt16LE(p + 28)
    const extraLen = zip.readUInt16LE(p + 30)
    const commentLen = zip.readUInt16LE(p + 32)
    const local = zip.readUInt32LE(p + 42)
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString("utf8")

    expect(zip.readUInt32LE(local)).toBe(0x04034b50)
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
    const body = zip.subarray(start, start + csize)
    const data = method === 0 ? body : zlib.inflateRawSync(body)
    expect(crc32(data)).toBe(crc)
    out[name] = data.toString("utf8")
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

describe("zip writer", () => {
  it("matches the CRC-32 the spec requires", () => {
    expect(crc32(Buffer.from("hello world"))).toBe(0x0d4a1185)
    expect(crc32(Buffer.alloc(0))).toBe(0)
  })

  it("round-trips text files, including UTF-8 names and folders", () => {
    const zip = zipBuffer([
      { name: "results.csv", data: Buffer.from("IP,Status\r\n10.0.0.1,Pass\r\n", "utf8") },
      { name: "run_2026/สวัสดี.log", data: Buffer.from("x".repeat(5000), "utf8") },
      { name: "empty.log", data: Buffer.alloc(0) },
    ])
    const back = unzip(zip)
    expect(Object.keys(back).sort()).toEqual(["empty.log", "results.csv", "run_2026/สวัสดี.log"])
    expect(back["results.csv"]).toContain("10.0.0.1,Pass")
    expect(back["run_2026/สวัสดี.log"]).toHaveLength(5000)
    // Repeated text must actually compress, otherwise the "zip" is just a container.
    expect(zip.length).toBeLessThan(2000)
  })

  it("packs a whole run folder under one prefix", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onsite-zip-"))
    fs.writeFileSync(path.join(dir, "job.log"), "line one\n")
    fs.mkdirSync(path.join(dir, "devices"))
    fs.writeFileSync(path.join(dir, "devices", "sw1.log"), "show version\n")
    const back = unzip(zipBuffer(folderEntries(dir, "session_1")))
    expect(Object.keys(back).sort()).toEqual(["session_1/devices/sw1.log", "session_1/job.log"])
    expect(back["session_1/job.log"]).toBe("line one\n")
  })
})
