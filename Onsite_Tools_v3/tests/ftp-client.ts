/** Just enough of an FTP client to behave like "copy ftp://..." on a switch (passive mode, binary RETR). */
import net from "node:net"

export class FtpClient {
  private buf = ""
  private waiters: ((line: string) => void)[] = []

  private constructor(private sock: net.Socket) {
    sock.on("error", () => undefined)
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

  static async connect(port: number, host = "127.0.0.1") {
    const c = new FtpClient(net.connect(port, host))
    const greeting = await c.read()
    if (!greeting.startsWith("220")) throw new Error(`unexpected greeting: ${greeting}`)
    return c
  }

  read() { return new Promise<string>((r) => this.waiters.push(r)) }
  cmd(line: string) { const p = this.read(); this.sock.write(line + "\r\n"); return p }

  async login(user: string, password: string) {
    await this.cmd(`USER ${user}`)
    return this.cmd(`PASS ${password}`)
  }

  async download(file: string): Promise<Buffer> {
    const pasv = await this.cmd("PASV")
    const n = /\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/.exec(pasv)?.slice(1).map(Number)
    if (!n) throw new Error(pasv)
    const data = net.connect(n[4] * 256 + n[5], n.slice(0, 4).join("."))
    const chunks: Buffer[] = []
    data.on("data", (c) => chunks.push(c))
    const closed = new Promise<void>((r) => data.on("close", () => r()))
    const start = await this.cmd(`RETR ${file}`)
    if (!start.startsWith("150")) throw new Error(start)
    await closed
    const end = await this.read()
    if (!end.startsWith("226")) throw new Error(end)
    return Buffer.concat(chunks)
  }

  end() { this.sock.destroy() }
}
