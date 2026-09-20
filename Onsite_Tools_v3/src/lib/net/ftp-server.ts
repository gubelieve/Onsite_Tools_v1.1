/**
 * Built-in, read-only FTP server that serves exactly ONE file (the IOS image) for the duration of an upgrade run,
 * so nobody has to install and start FileZilla / IIS by hand.
 *
 * Deliberately tiny: one-time random credentials, no uploads, no directory access, only the chosen file can be read.
 * Supports passive (PASV / EPSV) and active (PORT) mode - Cisco IOS uses passive by default.
 */
import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"

export interface Transfer { sent: number; total: number; done: boolean }

const v4 = (addr: string | undefined) => (addr ?? "").replace(/^::ffff:/, "")

export class SingleFileFtpServer {
  readonly user = "onsite"
  readonly password = crypto.randomBytes(9).toString("base64url").replace(/[^A-Za-z0-9]/g, "x")
  readonly fileName: string
  readonly size: number
  /** Progress per client IP - read by the upgrade job to show live upload progress. */
  readonly transfers = new Map<string, Transfer>()
  /** Every client that opened a control connection, and every client that got past the password.
   *  A failed copy with an empty `clients` set means nothing reached this PC at all - firewall or routing. */
  readonly clients = new Set<string>()
  readonly authenticated = new Set<string>()
  port = 0
  private server?: net.Server
  private sockets = new Set<net.Socket>()

  /** `publishAs` = name the file is offered under (no spaces, so it is safe inside a "copy ftp://..." URL). */
  constructor(private filePath: string, publishAs?: string) {
    this.fileName = publishAs || path.basename(filePath)
    this.size = fs.statSync(filePath).size
  }

  start(port = 21, host = "0.0.0.0"): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((s) => this.session(s))
      server.once("error", (e: NodeJS.ErrnoException) => reject(new Error(
        e.code === "EADDRINUSE" ? `Port ${port} is already in use - another FTP server is running on this PC. Stop it, or choose "External FTP server".`
          : e.code === "EACCES" ? `No permission to listen on port ${port}. Run the app as administrator/root or use SCP.` : e.message)))
      server.listen(port, host, () => { this.server = server; this.port = (server.address() as net.AddressInfo).port; resolve() })
    })
  }

  stop(): Promise<void> {
    for (const s of this.sockets) s.destroy()
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()))
  }

  private matches(arg: string) {
    return arg.replace(/\\/g, "/").split("/").pop()?.toLowerCase() === this.fileName.toLowerCase()
  }

  private session(ctrl: net.Socket) {
    this.sockets.add(ctrl)
    const client = v4(ctrl.remoteAddress)
    this.clients.add(client)
    let user = "", authed = false, offset = 0, buffer = ""
    let passive: net.Server | null = null
    let pending: Promise<net.Socket> | null = null
    let active: { host: string; port: number } | null = null
    const reply = (line: string) => { if (!ctrl.destroyed) ctrl.write(line + "\r\n") }
    const closePassive = () => { passive?.close(); passive = null; pending = null }

    const openPassive = () => new Promise<number>((resolve, reject) => {
      closePassive()
      const srv = net.createServer()
      passive = srv
      pending = new Promise<net.Socket>((res) => srv.once("connection", (d) => { this.sockets.add(d); res(d) }))
      srv.once("error", reject)
      srv.listen(0, "0.0.0.0", () => resolve((srv.address() as net.AddressInfo).port))
    })

    const dataSocket = async (): Promise<net.Socket> => {
      if (pending) return pending
      if (active) {
        const target = active
        return new Promise((resolve, reject) => {
          const d = net.connect(target.port, target.host, () => resolve(d))
          this.sockets.add(d)
          d.once("error", reject)
        })
      }
      throw new Error("no data connection")
    }

    const send = async (produce: (d: net.Socket) => Promise<void>) => {
      try {
        reply("150 Opening BINARY mode data connection")
        const d = await dataSocket()
        await produce(d)
        reply("226 Transfer complete")
      } catch (e) {
        reply(`426 Transfer aborted: ${(e as Error).message}`)
      } finally { closePassive(); active = null; offset = 0 }
    }

    const handle = async (line: string) => {
      const [cmdRaw, ...rest] = line.trim().split(" ")
      const cmd = cmdRaw.toUpperCase(), arg = rest.join(" ")
      if (cmd === "USER") { user = arg; return reply("331 Password required") }
      if (cmd === "PASS") {
        authed = user === this.user && arg === this.password
        if (authed) this.authenticated.add(client)
        return reply(authed ? "230 Logged in" : "530 Login incorrect")
      }
      if (cmd === "QUIT") { reply("221 Goodbye"); ctrl.end(); return }
      if (cmd === "FEAT") return reply("211-Features:\r\n SIZE\r\n EPSV\r\n REST STREAM\r\n211 End")
      if (cmd === "SYST") return reply("215 UNIX Type: L8")
      if (!authed) return reply("530 Please login with USER and PASS")
      switch (cmd) {
        case "PWD": case "XPWD": return reply('257 "/" is the current directory')
        case "CWD": case "CDUP": return reply("250 OK")
        case "TYPE": case "MODE": case "STRU": case "NOOP": case "OPTS": case "ALLO": return reply("200 OK")
        case "REST": offset = Math.max(0, Number(arg) || 0); return reply(`350 Restarting at ${offset}`)
        case "SIZE": return reply(this.matches(arg) ? `213 ${this.size}` : "550 File not found")
        case "MDTM": return reply(this.matches(arg) ? "213 20200101000000" : "550 File not found")
        case "PASV": {
          const port = await openPassive()
          const ip = v4(ctrl.localAddress).split(".")
          return reply(`227 Entering Passive Mode (${ip.join(",")},${port >> 8},${port & 255})`)
        }
        case "EPSV": return reply(`229 Entering Extended Passive Mode (|||${await openPassive()}|)`)
        case "PORT": {
          const n = arg.split(",").map(Number)
          if (n.length !== 6 || n.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return reply("501 Bad PORT")
          closePassive()
          active = { host: n.slice(0, 4).join("."), port: n[4] * 256 + n[5] }
          return reply("200 PORT command successful")
        }
        case "LIST": case "NLST":
          return send(async (d) => new Promise((res) => d.end(cmd === "NLST" ? `${this.fileName}\r\n`
            : `-r--r--r-- 1 ftp ftp ${this.size} Jan 01 00:00 ${this.fileName}\r\n`, () => res())))
        case "RETR": {
          if (!this.matches(arg)) return reply("550 File not found")
          const start = offset
          return send((d) => new Promise<void>((resolve, reject) => {
            const t: Transfer = { sent: start, total: this.size, done: false }
            this.transfers.set(client, t)
            const rs = fs.createReadStream(this.filePath, { start, highWaterMark: 256 * 1024 })
            rs.on("data", (chunk) => { t.sent += chunk.length })
            rs.once("error", reject)
            d.once("error", reject)
            d.once("close", () => (t.sent >= this.size ? (t.done = true, resolve()) : reject(new Error("client closed the data connection"))))
            rs.pipe(d)
          }))
        }
        case "STOR": case "APPE": case "DELE": case "MKD": case "RMD": case "RNFR": case "RNTO":
          return reply("550 Read-only server")
        default: return reply("502 Command not implemented")
      }
    }

    // Commands are handled strictly one after the other.
    let chain = Promise.resolve()
    ctrl.on("data", (chunk) => {
      buffer += chunk.toString("utf8")
      let i: number
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i).replace(/\r$/, "")
        buffer = buffer.slice(i + 1)
        if (line.trim()) chain = chain.then(() => handle(line)).catch(() => reply("451 Local error"))
      }
    })
    ctrl.on("error", () => undefined)
    ctrl.on("close", () => { closePassive(); this.sockets.delete(ctrl) })
    reply("220 Onsite Tools FTP (read-only, single file)")
  }
}
