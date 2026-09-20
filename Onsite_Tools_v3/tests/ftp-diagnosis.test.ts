import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { SingleFileFtpServer } from "@/lib/net/ftp-server"
import { localAddresses } from "@/lib/net/firewall"
import { explainFtpFailure } from "@/lib/tools/upgrade-ios"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onsite-diag-"))
const image = path.join(dir, "image.bin")
fs.writeFileSync(image, crypto.randomBytes(1024))
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })

const DEVICE = "10.0.205.249"
const FTP_IP = "192.168.9.30"
const TIMED_OUT = "Accessing ftp://192.168.9.30/image.bin...\n%Error opening ftp://192.168.9.30/image.bin (Timed out)\n"

function server(o: { clients?: string[]; authenticated?: string[] } = {}) {
  const ftp = new SingleFileFtpServer(image)
  for (const c of o.clients ?? []) ftp.clients.add(c)
  for (const c of o.authenticated ?? []) ftp.authenticated.add(c)
  return ftp
}

describe("why did the FTP copy fail", () => {
  it("quotes what the device itself said", async () => {
    const msg = await explainFtpFailure(server(), TIMED_OUT, DEVICE, FTP_IP)
    expect(msg).toContain('The device reported "%Error opening ftp://192.168.9.30/image.bin (Timed out)"')
  })

  it("nothing reached this PC: names the address, the interfaces and the SCP way out", async () => {
    const msg = await explainFtpFailure(server(), TIMED_OUT, DEVICE, FTP_IP)
    expect(msg).toContain(`never opened a connection to ${FTP_IP}:`)
    expect(msg).toMatch(/SCP push/)
    // Either a real Windows Block rule is named, or the message lists what this PC could advertise instead.
    const listsInterfaces = localAddresses().every((a) => msg.includes(a))
    expect(listsInterfaces || /Windows Firewall is blocking it/.test(msg)).toBe(true)
  })

  it("reached but never logged in: points at the device's own ip ftp credentials", async () => {
    const msg = await explainFtpFailure(server({ clients: [DEVICE] }), TIMED_OUT, DEVICE, FTP_IP)
    expect(msg).toContain("did not log in")
    expect(msg).toContain("ip ftp username / password")
  })

  it("a different source address: points at ip ftp source-interface", async () => {
    const ftp = server({ clients: ["10.0.205.1"], authenticated: ["10.0.205.1"] })
    const msg = await explainFtpFailure(ftp, TIMED_OUT, DEVICE, FTP_IP)
    expect(msg).toContain("A connection arrived from 10.0.205.1 rather than 10.0.205.249")
    expect(msg).toContain("ip ftp source-interface")
  })

  it("logged in but no data: blames the passive data port, not the control port", async () => {
    const ftp = server({ clients: [DEVICE], authenticated: [DEVICE] })
    const msg = await explainFtpFailure(ftp, "", DEVICE, FTP_IP)
    expect(msg).toContain("the data connection that failed")
    expect(msg).toContain("second port")
    expect(msg).not.toContain("The device reported") // nothing was said, so nothing is quoted
  })

  it("a live server records who connected and who got past the password", async () => {
    const ftp = new SingleFileFtpServer(image)
    await ftp.start(0, "127.0.0.1")
    try {
      const { FtpClient } = await import("./ftp-client")
      const bad = await FtpClient.connect(ftp.port)
      expect(await bad.login(ftp.user, "wrong-password")).toMatch(/^530 /)
      bad.end()
      expect([...ftp.clients]).toEqual(["127.0.0.1"])
      expect(ftp.authenticated.size).toBe(0)

      const good = await FtpClient.connect(ftp.port)
      expect(await good.login(ftp.user, ftp.password)).toMatch(/^230 /)
      good.end()
      expect([...ftp.authenticated]).toEqual(["127.0.0.1"])
    } finally { await ftp.stop() }
  })
})
