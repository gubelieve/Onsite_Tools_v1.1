/**
 * SCP push (PC -> device) over SSH. Nothing has to listen on the PC, so there is no FTP server to start and no
 * inbound firewall rule to open. The device must run an SCP server (Cisco: "ip scp server enable") and the user
 * must land in privilege 15.
 */
import fs from "node:fs"
import { Client } from "ssh2"
import { LEGACY_ALGORITHMS } from "./ssh"

export interface ScpOptions {
  host: string; port?: number; username: string; password: string; timeoutSec?: number
  /** e.g. "flash:cat9k-iosxe.17.09.05.SPA.bin" */
  remotePath: string
  localFile: string
  onProgress?: (sent: number, total: number) => void
  shouldStop?: () => boolean
}

export function scpPush(o: ScpOptions): Promise<number> {
  const size = fs.statSync(o.localFile).size
  const name = o.remotePath.split(/[:/\\]/).pop() || "image.bin"
  return new Promise((resolve, reject) => {
    const client = new Client()
    let settled = false
    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      try { client.end() } catch { /* ignore */ }
      if (err) reject(err); else resolve(size)
    }
    client
      .on("keyboard-interactive", (_n, _i, _l, prompts, done) => done(prompts.map(() => o.password)))
      .on("error", (e) => finish(e))
      .on("ready", () => {
        client.exec(`scp -t ${o.remotePath}`, (err, ch) => {
          if (err) return finish(err)
          let stderr = "", step = 0, sent = 0
          ch.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8") })
          ch.on("close", () => finish(step >= 3 ? undefined : new Error(`SCP ended early${stderr ? `: ${stderr.trim()}` : ""}. Is "ip scp server enable" configured and does the user have privilege 15?`)))

          const stream = () => {
            const rs = fs.createReadStream(o.localFile, { highWaterMark: 64 * 1024 })
            rs.on("data", (chunk) => {
              sent += chunk.length
              o.onProgress?.(sent, size)
              if (o.shouldStop?.()) { rs.destroy(); finish(new Error("Stopped by user")) }
            })
            rs.once("error", (e) => finish(e))
            rs.once("end", () => ch.write(Buffer.from([0]))) // end-of-file marker
            rs.pipe(ch, { end: false })
          }

          // The sink acknowledges each step with one byte: 0 = ok, 1 = warning, 2 = fatal (+ a message line).
          ch.on("data", (d: Buffer) => {
            if (d[0] !== 0) return finish(new Error(`SCP refused: ${d.subarray(1).toString("utf8").trim() || `code ${d[0]}`}`))
            step++
            if (step === 1) ch.write(`C0644 ${size} ${name}\n`)
            else if (step === 2) stream()
            else if (step === 3) ch.end()
          })
        })
      })
      .connect({
        host: o.host, port: o.port ?? 22, username: o.username, password: o.password, tryKeyboard: true,
        readyTimeout: (o.timeoutSec ?? 30) * 1000, keepaliveInterval: 15000, algorithms: LEGACY_ALGORITHMS,
      })
  })
}
