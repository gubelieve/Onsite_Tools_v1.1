/** A tiny SSH server that behaves like a Cisco IOS CLI - lets the SSH driver be tested without hardware. */
import crypto from "node:crypto"
import { Server, type Connection } from "ssh2"
import { FtpClient } from "./ftp-client"

export interface FakeDevice { port: number; commands: string[]; flash: Map<string, Buffer>; inactive: string[]; close: () => Promise<void> }

const RESPONSES: Record<string, string> = {
  "show version": "Cisco IOS XE Software, Version 17.09.04a\nSW-LAB-01 uptime is 3 weeks\nROM: IOS-XE ROMMON",
  "show inventory": 'NAME: "c93xx Stack", DESCR: "c93xx Stack"\nPID: C9300-24T       , VID: V02  , SN: FOC1234X0AB',
  "show clock": "*10:15:01.123 ICT Sat Sep 20 2026",
  "show bad": "% Invalid input detected at '^' marker.",
}

const INACTIVE = [
  "/flash/cat9k-cc_srdriver.16.12.05b.SPA.pkg",
  "/flash/cat9k-espbase.16.12.05b.SPA.pkg",
  "/flash/cat9k_iosxe.16.12.05b.SPA.bin",
]

export function startFakeDevice(
  o: { hostname?: string; username?: string; password?: string; ftpPort?: number; inactive?: string[]; noInstallCommand?: boolean } = {},
): Promise<FakeDevice> {
  const hostname = o.hostname ?? "SW-LAB-01"
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 })
  const hostKey = privateKey.export({ type: "pkcs1", format: "pem" }) as string
  const commands: string[] = []
  const flash = new Map<string, Buffer>()
  // Files "install remove inactive" offers to delete; answering y empties this list and frees the space.
  const inactive = [...(o.inactive ?? INACTIVE)]
  let freeBytes = 200 * 1024 * 1024
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
          let removing = false // waiting for the answer to "Do you want to remove the above files? [y/n]"
          let copy: { user: string; pass: string; host: string; file: string } | null = null
          const runCopy = async (dest: string) => {
            const job = copy!
            copy = null
            try {
              const ftp = await FtpClient.connect(o.ftpPort ?? 21, job.host)
              const login = await ftp.login(job.user, job.pass)
              if (!login.startsWith("230")) throw new Error("%Error opening ftp (Permission denied)")
              ch.write(`Accessing ftp://${job.host}/${job.file}...\r\nLoading ${job.file} !!!!!!\r\n`)
              const data = await ftp.download(job.file)
              ftp.end()
              flash.set(dest, data)
              ch.write(`[OK - ${data.length}/4096 bytes]\r\n\r\n${data.length} bytes copied in 1.234 secs (1000 bytes/sec)\r\n`)
            } catch (e) {
              ch.write(`${(e as Error).message.startsWith("%") ? (e as Error).message : "%Error opening ftp (Timed out)"}\r\n`)
            }
            ch.write(prompt())
          }
          const prompt = () => `${hostname}${config ? "(config)" : ""}#`
          ch.write(`\r\nWelcome to the lab\r\n\r\n${prompt()}`)
          ch.on("data", (d: Buffer) => {
            for (const c of d.toString("utf8")) {
              if (c !== "\n" && c !== "\r") { line += c; continue }
              const cmd = line.trim()
              line = ""
              ch.write(`${cmd}\r\n`) // devices echo what was typed
              if (cmd) commands.push(cmd)
              if (removing) { // answer to "Do you want to remove the above files? [y/n]"
                removing = false
                if (/^y/i.test(cmd)) {
                  ch.write(`[switch 1]:\r\n${inactive.map((f) => `Deleting file ${f} ... done.`).join("\r\n")}\r\n` +
                    "SUCCESS: Files deleted.\r\n--- Starting Post_Remove_Cleanup ---\r\nSUCCESS: Post_Remove_Cleanup finished\r\n" +
                    "install_remove: END SUCCESS\r\n")
                  freeBytes += inactive.length * 20 * 1024 * 1024
                  inactive.length = 0
                } else ch.write("install_remove: ABORT\r\n")
                ch.write(prompt())
                return
              }
              if (cmd === "install remove inactive") {
                // A device in bundle mode (or an older IOS) does not have the command at all.
                if (o.noInstallCommand) { ch.write("% Invalid input detected at '^' marker.\r\n" + prompt()); return }
                ch.write("install_remove: START\r\nCleaning up unnecessary package files\r\n  Scanning boot directory for packages ... done.\r\n")
                if (!inactive.length) { ch.write("SUCCESS: No extra package or provisioning files found on media. Nothing to clean.\r\ninstall_remove: END SUCCESS\r\n" + prompt()); return }
                ch.write(`\r\nThe following files will be deleted:\r\n[switch 1]:\r\n${inactive.join("\r\n")}\r\n\r\n` +
                  "Do you want to remove the above files? [y/n]")
                removing = true
                return
              }
              if (cmd === "dir flash:") { ch.write(`Directory of flash:/\r\n\r\n1024000 bytes total (${freeBytes} bytes free)\r\n` + prompt()); return }
              if (copy) { void runCopy(cmd || copy.file); return } // answer to "Destination filename [x]?"
              const m = /^copy ftp:\/\/([^:]+):([^@]+)@([^/]+)\/(\S+) flash:(\S+)$/.exec(cmd)
              if (m) { copy = { user: m[1], pass: m[2], host: m[3], file: m[4] }; ch.write(`Destination filename [${m[5]}]? `); return }
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
      resolve({ port, commands, flash, inactive, close: () => new Promise((r) => { clients.forEach((c) => c.end()); server.close(() => r()) }) })
    })
  })
}
