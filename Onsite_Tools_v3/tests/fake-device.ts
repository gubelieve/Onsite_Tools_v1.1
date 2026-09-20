/** A tiny SSH server that behaves like a Cisco IOS CLI - lets the SSH driver be tested without hardware. */
import crypto from "node:crypto"
import { Server, type Connection } from "ssh2"

export interface FakeDevice { port: number; commands: string[]; close: () => Promise<void> }

const RESPONSES: Record<string, string> = {
  "show version": "Cisco IOS XE Software, Version 17.09.04a\nSW-LAB-01 uptime is 3 weeks\nROM: IOS-XE ROMMON",
  "show inventory": 'NAME: "c93xx Stack", DESCR: "c93xx Stack"\nPID: C9300-24T       , VID: V02  , SN: FOC1234X0AB',
  "show clock": "*10:15:01.123 ICT Sat Sep 20 2026",
  "show bad": "% Invalid input detected at '^' marker.",
}

export function startFakeDevice(o: { hostname?: string; username?: string; password?: string; paged?: boolean } = {}): Promise<FakeDevice> {
  const hostname = o.hostname ?? "SW-LAB-01"
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 })
  const hostKey = privateKey.export({ type: "pkcs1", format: "pem" }) as string
  const commands: string[] = []
  const clients = new Set<Connection>()

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client)
    client.on("close", () => clients.delete(client)).on("error", () => undefined)
    client.on("authentication", (ctx) => {
      if (ctx.method === "password" && ctx.username === (o.username ?? "admin") && ctx.password === (o.password ?? "secret")) ctx.accept()
      else ctx.reject(["password"])
    })
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept()
        session.on("pty", (a) => a?.())
        session.on("shell", (acceptShell) => {
          const ch = acceptShell()
          let config = false, line = ""
          const prompt = () => `${hostname}${config ? "(config)" : ""}#`
          ch.write(`\r\nWelcome to the lab\r\n\r\n${prompt()}`)
          ch.on("data", (d: Buffer) => {
            for (const c of d.toString("utf8")) {
              if (c !== "\n" && c !== "\r") { line += c; continue }
              const cmd = line.trim()
              line = ""
              ch.write(`${cmd}\r\n`) // devices echo what was typed
              if (cmd) commands.push(cmd)
              if (cmd === "configure terminal") config = true
              else if (cmd === "end") config = false
              else if (cmd === "exit") { ch.close(); return }
              else if (cmd.startsWith("screen-length")) ch.write("% Invalid input detected at '^' marker.\r\n")
              else if (RESPONSES[cmd]) ch.write(RESPONSES[cmd].replace(/\n/g, "\r\n") + "\r\n")
              ch.write(prompt())
            }
          })
        })
      })
    })
  })

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port
      resolve({ port, commands, close: () => new Promise((r) => { clients.forEach((c) => c.end()); server.close(() => r()) }) })
    })
  })
}
