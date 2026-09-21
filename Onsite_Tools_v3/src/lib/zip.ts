/**
 * Minimal ZIP writer - enough to hand a run's log folder to the user as one file.
 * Written here rather than pulled in as a dependency: the app has to stay "copy the folder and run it",
 * and everything it zips is small text (logs, CSV). Plain zip, no zip64, so 4 GB is the hard limit.
 */
import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"

export interface ZipEntry { name: string; data: Buffer; date?: Date }

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

export function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** MS-DOS timestamp - seconds have two-second resolution, and 1980 is year zero. */
function dosTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear())
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

const MAX = 0xffffffff

export function zipBuffer(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name.replace(/\\/g, "/"), "utf8")
    if (e.data.length > MAX) throw new Error(`${e.name} is too large for a plain zip file`)
    const deflated = zlib.deflateRawSync(e.data, { level: 6 })
    // Already-compressed files (images, .bin) can grow when deflated - store those as they are.
    const stored = deflated.length >= e.data.length
    const body = stored ? e.data : deflated
    const { time, date } = dosTime(e.date ?? new Date())
    const crc = crc32(e.data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)      // version needed
    local.writeUInt16LE(0x800, 6)   // UTF-8 file names
    local.writeUInt16LE(stored ? 0 : 8, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, body)

    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0)
    dir.writeUInt16LE(20, 4)        // version made by
    dir.writeUInt16LE(20, 6)        // version needed
    dir.writeUInt16LE(0x800, 8)
    dir.writeUInt16LE(stored ? 0 : 8, 10)
    dir.writeUInt16LE(time, 12)
    dir.writeUInt16LE(date, 14)
    dir.writeUInt32LE(crc, 16)
    dir.writeUInt32LE(body.length, 20)
    dir.writeUInt32LE(e.data.length, 24)
    dir.writeUInt16LE(name.length, 28)
    dir.writeUInt32LE(offset, 42)
    central.push(dir, name)

    offset += local.length + name.length + body.length
    if (offset > MAX) throw new Error("Too much data for a plain zip file")
  }
  const dirBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(dirBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dirBuf, end])
}

/** Every file under `dir`, named relative to `prefix/`. Unreadable files are skipped, not fatal. */
export function folderEntries(dir: string, prefix = ""): ZipEntry[] {
  const entries: ZipEntry[] = []
  const walk = (current: string, rel: string) => {
    let items: fs.Dirent[]
    try { items = fs.readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const item of items) {
      const full = path.join(current, item.name)
      const name = rel ? `${rel}/${item.name}` : item.name
      if (item.isDirectory()) walk(full, name)
      else if (item.isFile()) {
        try { entries.push({ name: prefix ? `${prefix}/${name}` : name, data: fs.readFileSync(full), date: fs.statSync(full).mtime }) }
        catch { /* a log being written right now - skip it rather than fail the download */ }
      }
    }
  }
  walk(dir, "")
  return entries
}
