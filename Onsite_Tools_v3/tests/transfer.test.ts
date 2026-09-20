import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { Server } from "ssh2"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { SingleFileFtpServer } from "@/lib/net/ftp-server"
import { scpPush } from "@/lib/net/scp"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onsite-transfer-"))
const image = path.join(dir, "cat9k_iosxe.17.09.05.SPA.bin")
const payload = crypto.randomBytes(3 * 1024 * 1024 + 123) // not a multiple of any buffer size
fs.writeFileSync(image, payload)
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

/** Just enough of an FTP client to behave like "copy ftp://..." on a switch. */
class FtpClient {
  private buf = ""
  private waiters: ((line: string) => void)[] = []
  private constructor(private sock: net.Socket) {
    sock.on("data", (d) => {
      this.buf += d.toString()
      let i: number
      while ((i = this.buf.indexOf("\r\n")) >= 0) {
        const line = this.buf.slice(0, i)
        this.buf = this.buf.slice(i + 2)
        if (/^\d{3} /.test(line)) this.waiters.shift()?.(line) // skip "211-" continuation lines
      }
    })
  }
  static async connect(port: number) {
    const sock = net.connect(port, "127.0.0.1")
    const c = new FtpClient(sock)
    expect(await c.read()).toMatch(/^220 /)
    return c
  }
  read() { return new Promise<string>((r) => this.waiters.push(r)) }
  cmd(line: string) { const p = this.read(); this.sock.write(line + "\r\n"); return p }
  async download(file: string): Promise<Buffer> {
    const pasv = await this.cmd("PASV")
    const n = /\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/.exec(pasv)!.slice(1).map(Number)
    const data = net.connect(n[4] * 256 + n[5], n.slice(0, 4).join("."))
    const chunks: Buffer[] = []
    data.on("data", (c) => chunks.push(c))
    const closed = new Promise<void>((r) => data.on("close", () => r()))
    expect(await this.cmd(`RETR ${file}`)).toMatch(/^150 /)
    await closed
    expect(await this.read()).toMatch(/^226 /)
    return Buffer.concat(chunks)
  }
  end() { this.sock.destroy() }
}

describe("built-in FTP server", () => {
  let ftp: SingleFileFtpServer
  beforeAll(async () => { ftp = new SingleFileFtpServer(image); await ftp.start(0, "127.0.0.1") })
  afterAll(() => ftp.stop())

  it("serves the image byte-for-byte to an authenticated client and tracks progress", async () => {
    const c = await FtpClient.connect(ftp.port)
    expect(await c.cmd(`USER ${ftp.user}`)).toMatch(/^331 /)
    expect(await c.cmd(`PASS ${ftp.password}`)).toMatch(/^230 /)
    expect(await c.cmd("TYPE I")).toMatch(/^200 /)
    expect(await c.cmd(`SIZE ${ftp.fileName}`)).toBe(`213 ${payload.length}`)
    const got = await c.download(`/${ftp.fileName}`)
    expect(got.equals(payload)).toBe(true)
    expect(ftp.transfers.get("127.0.0.1")).toEqual({ sent: payload.length, total: payload.length, done: true })
    c.end()
  })

  it("rejects wrong credentials, other files and every write", async () => {
    const anon = await FtpClient.connect(ftp.port)
    await anon.cmd("USER anonymous")
    expect(await anon.cmd("PASS guest@")).toMatch(/^530 /)
    expect(await anon.cmd("PASV")).toMatch(/^530 /)
    anon.end()

    const c = await FtpClient.connect(ftp.port)
    await c.cmd(`USER ${ftp.user}`)
    await c.cmd(`PASS ${ftp.password}`)
    expect(await c.cmd("RETR ../../windows/win.ini")).toMatch(/^550 /)
    expect(await c.cmd("SIZE settings.json")).toMatch(/^550 /)
    expect(await c.cmd("STOR evil.bin")).toMatch(/^550 /)
    expect(await c.cmd("DELE " + ftp.fileName)).toMatch(/^550 /)
    c.end()
  })

  it("uses a fresh random password for every server", () => {
    expect(new SingleFileFtpServer(image).password).not.toBe(ftp.password)
    expect(ftp.password).toMatch(/^[A-Za-z0-9]{10,}$/) // safe inside "copy ftp://user:pass@host/..."
  })
})

describe("SCP push", () => {
  /** SSH server whose exec channel implements the receiving side of "scp -t". */
  function startSink(mode: "ok" | "refuse") {
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 })
    const received: { command: string; header: string; data: Buffer } = { command: "", header: "", data: Buffer.alloc(0) }
    const server = new Server({ hostKeys: [privateKey.export({ type: "pkcs1", format: "pem" }) as string] }, (client) => {
      client.on("error", () => undefined)
      client.on("authentication", (ctx) => (ctx.method === "password" && ctx.password === "secret" ? ctx.accept() : ctx.reject(["password"])))
      client.on("ready", () => client.on("session", (accept) => accept().on("exec", (acceptExec, _r, info) => {
        const ch = acceptExec()
        received.command = info.command
        if (mode === "refuse") { ch.write(Buffer.concat([Buffer.from([1]), Buffer.from("scp: flash: Permission denied\n")])); ch.exit(1); ch.end(); return }
        let size = -1, buf = Buffer.alloc(0)
        ch.write(Buffer.from([0]))
        ch.on("data", (d: Buffer) => {
          buf = Buffer.concat([buf, d])
          if (size < 0) {
            const nl = buf.indexOf(10)
            if (nl < 0) return
            received.header = buf.subarray(0, nl).toString()
            size = Number(received.header.split(" ")[1])
            buf = buf.subarray(nl + 1)
            ch.write(Buffer.from([0]))
          }
          if (size >= 0 && buf.length >= size + 1) { received.data = buf.subarray(0, size); ch.write(Buffer.from([0])); ch.exit(0); ch.end() }
        })
      })))
    })
    return new Promise<{ port: number; received: typeof received; close: () => void }>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, received, close: () => server.close() })))
  }

  it("sends the file with the scp sink protocol and reports progress", async () => {
    const sink = await startSink("ok")
    const progress: number[] = []
    const sent = await scpPush({ host: "127.0.0.1", port: sink.port, username: "admin", password: "secret", localFile: image,
      remotePath: "flash:cat9k-iosxe.17.09.05.SPA.bin", onProgress: (n) => progress.push(n) })
    sink.close()
    expect(sent).toBe(payload.length)
    expect(sink.received.command).toBe("scp -t flash:cat9k-iosxe.17.09.05.SPA.bin")
    expect(sink.received.header).toBe(`C0644 ${payload.length} cat9k-iosxe.17.09.05.SPA.bin`)
    expect(sink.received.data.equals(payload)).toBe(true)
    expect(progress.at(-1)).toBe(payload.length)
  })

  it("turns a refusal from the device into a readable error", async () => {
    const sink = await startSink("refuse")
    const err = await scpPush({ host: "127.0.0.1", port: sink.port, username: "admin", password: "secret", localFile: image, remotePath: "flash:x.bin" })
      .then(() => null, (e: Error) => e)
    sink.close()
    expect(err?.message).toMatch(/Permission denied/)
  })
})
