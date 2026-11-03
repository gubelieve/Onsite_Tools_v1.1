/**
 * Built-in, read-only HTTPS server that serves exactly ONE file (the IOS image) for the duration of an upgrade run -
 * the HTTPS counterpart of SingleFileFtpServer, for networks where FTP is not allowed or the image must not cross
 * the wire in clear text.
 *
 * One-time Basic credentials (carried in the "copy https://user:pass@..." URL), GET/HEAD of the one file only,
 * Range requests for a device that resumes. Only one port is used, so one firewall rule covers it - unlike passive FTP.
 */
import crypto from "node:crypto"
import fs from "node:fs"
import type http from "node:http"
import https from "node:https"
import type net from "node:net"
import path from "node:path"
import tls from "node:tls"
import type { Transfer } from "./ftp-server"
import type { ServerCert } from "./self-signed"

const v4 = (addr: string | undefined) => (addr ?? "").replace(/^::ffff:/, "")

/** Older IOS images only speak the CBC suites - keep them on offer next to Node's defaults. TLS 1.2 is the floor. */
const CIPHERS = `${tls.DEFAULT_CIPHERS}:AES128-SHA256:AES256-SHA256:AES128-SHA:AES256-SHA`

export class SingleFileHttpsServer {
  readonly user = "onsite"
  readonly password = crypto.randomBytes(9).toString("base64url").replace(/[^A-Za-z0-9]/g, "x")
  readonly fileName: string
  readonly size: number
  /** Progress per client IP - read by the upgrade job to show live upload progress. */
  readonly transfers = new Map<string, Transfer>()
  /** Same meaning as on the FTP server: who connected at all, and who got past the password. A client in
   *  `clients` that never shows up in `authenticated` usually rejected the certificate during the handshake. */
  readonly clients = new Set<string>()
  readonly authenticated = new Set<string>()
  /** Clients that dropped the TLS handshake - almost always "I do not trust this certificate". */
  readonly handshakeFailed = new Set<string>()
  port = 0
  private server?: https.Server
  private sockets = new Set<net.Socket>()

  constructor(private filePath: string, readonly certificate: ServerCert, publishAs?: string) {
    this.fileName = publishAs || path.basename(filePath)
    this.size = fs.statSync(filePath).size
  }

  start(port = 443, host = "0.0.0.0"): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = https.createServer({ cert: this.certificate.cert, key: this.certificate.key, minVersion: "TLSv1.2", ciphers: CIPHERS },
        (req, res) => this.handle(req, res))
      server.on("connection", (s: net.Socket) => {
        this.sockets.add(s)
        this.clients.add(v4(s.remoteAddress))
        s.on("close", () => this.sockets.delete(s))
      })
      server.on("tlsClientError", (_e, s) => this.handshakeFailed.add(v4(s.remoteAddress)))
      server.once("error", (e: NodeJS.ErrnoException) => reject(new Error(
        e.code === "EADDRINUSE" ? `Port ${port} is already in use on this PC (IIS, another web server?). Pick another HTTPS port, or stop that server.`
          : e.code === "EACCES" ? `No permission to listen on port ${port}. Run the app as administrator/root, or pick a port above 1024.` : e.message)))
      server.listen(port, host, () => { this.server = server; this.port = (server.address() as net.AddressInfo).port; resolve() })
    })
  }

  stop(): Promise<void> {
    for (const s of this.sockets) s.destroy()
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()))
  }

  private authorised(req: http.IncomingMessage): boolean {
    const [scheme, value] = (req.headers.authorization ?? "").split(" ")
    if (scheme?.toLowerCase() !== "basic" || !value) return false
    const given = Buffer.from(crypto.createHash("sha256").update(Buffer.from(value, "base64").toString("utf8")).digest())
    const want = crypto.createHash("sha256").update(`${this.user}:${this.password}`).digest()
    return crypto.timingSafeEqual(given, want)
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const client = v4(req.socket.remoteAddress)
    res.setHeader("Server", "Onsite Tools (read-only, single file)")
    if (!this.authorised(req)) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Onsite Tools"', "Content-Type": "text/plain" })
      res.end("Login required\n")
      return
    }
    this.authenticated.add(client)
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { Allow: "GET, HEAD" }); res.end(); return }
    const wanted = decodeURIComponent((req.url ?? "").split("?")[0]).split("/").pop()?.toLowerCase()
    if (wanted !== this.fileName.toLowerCase()) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("File not found\n"); return }

    let start = 0, end = this.size - 1
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""))
    if (range && (range[1] || range[2])) {
      start = range[1] ? Number(range[1]) : Math.max(0, this.size - Number(range[2]))
      end = range[1] && range[2] ? Math.min(Number(range[2]), this.size - 1) : this.size - 1
      if (start > end || start >= this.size) { res.writeHead(416, { "Content-Range": `bytes */${this.size}` }); res.end(); return }
    }
    const headers = { "Content-Type": "application/octet-stream", "Content-Length": String(end - start + 1), "Accept-Ranges": "bytes",
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${this.size}` } : {}) }
    res.writeHead(range ? 206 : 200, headers)
    if (req.method === "HEAD") { res.end(); return }

    const t: Transfer = { sent: start, total: this.size, done: false }
    this.transfers.set(client, t)
    const rs = fs.createReadStream(this.filePath, { start, end, highWaterMark: 256 * 1024 })
    rs.on("data", (chunk) => { t.sent += chunk.length })
    rs.on("end", () => { if (end === this.size - 1) t.done = true })
    rs.on("error", () => res.destroy())
    res.on("close", () => rs.destroy())
    rs.pipe(res)
  }
}
