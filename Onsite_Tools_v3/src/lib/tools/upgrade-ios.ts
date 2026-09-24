/**
 * IOS Upgrade - multi-stage Cisco IOS / IOS-XE upgrade. Each stage is a separate run so the results can be
 * reviewed in between. Stage 1 can transfer the image with the built-in FTP server (started automatically for the
 * run), by SCP push (nothing listens on the PC) or from an external FTP server that is already running.
 */
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { JobContext } from "../jobs"
import type { ToolDevice } from "../inventory"
import { noInboundHint } from "../net/firewall"
import { SingleFileFtpServer } from "../net/ftp-server"
import { scpPush } from "../net/scp"
import { SshSession } from "../net/ssh"
import { hms, safeName } from "../paths"
import { appendRun, openSession as openRunSession } from "../session"
import { localIp } from "../settings"
import { devicesFor, openSession } from "./common"
import { INVENTORY_FIELDS, num, str, type Params, type ToolDef } from "./types"

const STAGES = ["Verify Environment", "Upload IOS", "Verify MD5", "Install Image", "Check Status", "Verify Services",
  "List Inactive Images", "Remove Inactive Images"]
// "Progress" holds a percentage; the results table draws it as a bar (see job-panel).
const COLUMNS = ["Stage", "Host", "Hostname", "Status", "Progress", "Message", "Bytes Transferred", "Output", "Timestamp"]

/** One row per file to be deleted, up to this many - the rest are summarised. */
const MAX_FILE_ROWS = 60
/** What "install remove inactive" stops at when it wants an answer. */
const QUESTION = /Do you want to remove the above files\?\s*\[y\/n\]\s*$/i
const mb = (bytes: number) => (bytes / 1048576).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })
/** 95s -> "1m 35s", 4000s -> "1h 6m" - how long the transfer still has to go. */
const hms2 = (secs: number) => {
  const s = Math.round(secs)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`
}

/** The two cleanup runs are not part of the 0-5 sequence, so they are named rather than numbered. */
export const stageLabel = (stage: number) =>
  stage <= 5 ? `Stage ${stage}` : stage === 6 ? "Cleanup (list)" : "Cleanup (remove)"

function md5Of(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("md5")
    fs.createReadStream(file).on("data", (c) => h.update(c)).on("end", () => resolve(h.digest("hex"))).on("error", reject)
  })
}

/** File name of a Windows or POSIX path, whatever OS the app itself runs on. */
export const baseName = (file: string) => file.split(/[\\/]/).pop() ?? file

/** Cisco "copy" refuses some characters in the destination name. */
export const flashName = (file: string) => baseName(file).replace(/[_ ]/g, "-")

/**
 * Turn a failed "copy ftp://..." into something the user can act on: what the device said, plus which half of the
 * FTP conversation never happened. An empty `clients` set is the common one - nothing reached this PC at all.
 */
export async function explainFtpFailure(ftp: SingleFileFtpServer, out: string, deviceHost: string, ftpIp: string): Promise<string> {
  const spoke = /^\s*(%\s*Error[^\n]*|%\s*Warning[^\n]*)/im.exec(out)?.[1]?.trim()
  const said = spoke ? `The device reported "${spoke}". ` : ""
  const me = deviceHost.split(":")[0]
  const where = `${ftpIp}:${ftp.port}`
  if (ftp.clients.size === 0) return said + (await noInboundHint(ftpIp, ftp.port))
  if (ftp.authenticated.size === 0) {
    return said + `The device reached ${where} but did not log in. A device-side "ip ftp username / password" overrides the ` +
      "credentials in the copy command - remove it, or use an external FTP server that accepts those credentials."
  }
  if (!ftp.clients.has(me)) {
    return said + `A connection arrived from ${[...ftp.clients].join(", ")} rather than ${me}. If the device uses ` +
      '"ip ftp source-interface", that address has to be able to reach this PC too.'
  }
  return said + `The device logged in to ${where}, so it is the data connection that failed. Passive FTP opens a second port: ` +
    'allow this app through the Windows firewall for all ports, or use "SCP push", which needs no inbound connection.'
}

/**
 * The files "install remove inactive" offers to delete: the lines between "The following files will be deleted:"
 * and the [y/n] question. A stack repeats the list per member, so the "[switch N]" heading is kept with each file -
 * the same file name on two members is two different files.
 */
export function parseInactiveFiles(out: string): string[] {
  const start = /The following files will be deleted:?/i.exec(out)
  if (!start) return []
  const rest = out.slice(start.index + start[0].length)
  const stop = /Do you want to remove|SUCCESS:|FAILED:|install_remove:\s*(END|ABORT)|%\s*Error/i.exec(rest)
  const files: string[] = []
  let member = ""
  for (const raw of (stop ? rest.slice(0, stop.index) : rest).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const head = /^\[([^\]]+)\]:?$/.exec(line)
    if (head) { member = head[1].trim(); continue }
    if (!/^([/\\]|(flash|bootflash|crashinfo|harddisk|disk\d|usbflash\d)[\d-]*:)/i.test(line)) continue
    const file = member ? `${member}: ${line}` : line
    if (!files.includes(file)) files.push(file)
  }
  return files
}

/** One stage for one device. Exported for the end-to-end test against the fake device. */
export class Stage {
  hostname: string
  /** The row the transfer keeps updating, so progress is one moving bar and not a new line every few seconds. */
  private transferRow: string | null = null
  private startedAt = 0

  constructor(private ctx: JobContext, private params: Params, private device: ToolDevice, private stage: number,
              private iosFile: string, private ftpIp: string, private ftp: SingleFileFtpServer | null = null,
              private onBytes?: (host: string, sent: number) => void) {
    this.hostname = device.hostname || "Unknown"
  }

  private row(status: string, message: string, bytes = "0", output = "", progress = "") {
    return { Stage: stageLabel(this.stage), Host: this.device.host, Hostname: this.hostname, Status: status, Message: message,
      "Bytes Transferred": bytes, Progress: progress, Output: output, Timestamp: hms() }
  }

  private emit(status: string, message: string, bytes = "0", output = "") {
    this.ctx.addRow(this.row(status, message, bytes, output))
  }

  /**
   * The transfer's own row: written once, then updated in place. `percent` feeds the bar in the results table
   * and the job's overall progress; the message carries size, speed and what is left.
   */
  private transfer(status: string, message: string, sent = 0, size = 0, output = "") {
    const percent = size > 0 ? Math.min(100, (sent / size) * 100) : 0
    const row = this.row(status, message, String(sent), output, size > 0 ? percent.toFixed(1) : "")
    if (this.transferRow) this.ctx.updateRow(this.transferRow, row)
    else this.transferRow = this.ctx.addRow(row)
    this.onBytes?.(this.device.host, sent)
  }

  /** "412.5 / 1,199.8 MB (34.4%) · 5.8 MB/s · 2m 16s left" - everything the person watching wants to know. */
  private progressText(sent: number, size: number): string {
    const secs = (Date.now() - this.startedAt) / 1000
    const rate = secs > 0.5 ? sent / secs : 0
    const left = rate > 0 && sent < size ? (size - sent) / rate : 0
    return `${mb(sent)} / ${mb(size)} MB (${size ? ((sent / size) * 100).toFixed(1) : "0.0"}%)` +
      (rate ? ` · ${mb(rate)} MB/s` : "") + (left ? ` · ${hms2(left)} left` : "")
  }

  private logCmd(command: string, output: string, status = "Completed") {
    try {
      // safeName: a device stored as "10.0.0.1:2222" would otherwise be an illegal file name on Windows.
      fs.appendFileSync(path.join(this.ctx.runDir, `stage_${this.stage}_${safeName(this.device.host)}_${safeName(this.hostname)}.log`),
        `\n${"=".repeat(80)}\nTimestamp: ${new Date().toLocaleString("sv-SE")}\nHost: ${this.device.host}\nHostname: ${this.hostname}\n` +
        `Stage: ${stageLabel(this.stage)}\nStatus: ${status}\nCommand: ${command}\nOutput:\n${output}\n${"=".repeat(80)}\n`, "utf8")
    } catch { /* never break a stage because of logging */ }
  }

  private async run1(s: SshSession, cmd: string, timeoutSec = 60) {
    const out = await s.send(cmd, { timeoutSec })
    this.logCmd(cmd, out)
    return out
  }

  async run() {
    let s: SshSession
    try {
      s = await openSession(this.ctx, this.device, this.params, "cisco_ios")
      this.hostname = s.hostname || this.hostname
    } catch (e) { this.emit("Failed", `Connection failed: ${(e as Error).message}`); return }
    try {
      await [this.verifyEnvironment, this.upload, this.verifyMd5, this.install, this.checkStatus, this.verifyServices,
        this.listInactive, this.removeInactive][this.stage].call(this, s)
    } catch (e) {
      this.emit("Failed", `${stageLabel(this.stage)} failed: ${(e as Error).message}`, "0", String((e as Error).stack ?? e))
    } finally { s.close() }
  }

  private async verifyEnvironment(s: SshSession) {
    const ver = await this.run1(s, "show version")
    this.emit("Pass", `Device info: Hostname: ${this.hostname}, Model: ${/Cisco\s+(\S+)/i.exec(ver)?.[1] ?? "Unknown"}, IOS: ${/IOS.+Version\s+([^,]+)/.exec(ver)?.[1] ?? "Unknown"}`, "0", ver)

    const flash = await this.run1(s, "dir flash:")
    const free = /(\d+)\s+bytes free/.exec(flash)
    if (!free) { this.emit("Failed", "Failed to parse flash space", "0", flash); return }
    const need = fs.statSync(this.iosFile).size
    const msg = `${(Number(free[1]) / 1048576).toFixed(1)}MB free, ${(need / 1048576).toFixed(1)}MB required`
    this.emit(Number(free[1]) >= need ? "Pass" : "Failed", `Flash space ${Number(free[1]) >= need ? "OK" : "INSUFFICIENT"}: ${msg}`, "0", flash)

    const ping = await this.run1(s, `ping ${this.ftpIp} repeat 3`)
    const reachable = /Success rate is (100|80|66|60) percent/.test(ping)
    this.emit(reachable ? "Pass" : "Failed", `FTP server connectivity ${reachable ? "OK" : "FAILED"}: ${this.ftpIp}`, "0", ping)

    const run = (await this.run1(s, "show running-config", 120)).toLowerCase()
    const checks = { "SSH enabled": run.includes("ip ssh"), "Console timeout": run.includes("exec-timeout"), "Logging configured": run.includes("logging"), "NTP configured": run.includes("ntp") }
    this.emit("Pass", "Configuration checks: " + Object.entries(checks).map(([k, v]) => `${k}: ${v ? "OK" : "missing"}`).join(", "))

    const boot = await this.run1(s, "show boot")
    this.emit("Pass", `Current boot image: ${(/Boot image:\s+(.+)/.exec(boot) ?? /BOOT variable\s*=\s*(.+)/.exec(boot))?.[1]?.trim() ?? "Not configured"}`, "0", boot)

    const bootCfg = await this.run1(s, "show run all | i boot")
    const b = bootCfg.toLowerCase()
    if (b.includes("boot system rommon")) this.emit("Failed", "WARNING: boot system rommon detected - may cause boot issues", "0", bootCfg)
    else if (!b.includes("boot system flash") && !b.includes("packages.conf") && !b.includes("boot system switch")) this.emit("Failed", "WARNING: No boot system flash or packages.conf configured", "0", bootCfg)
    else this.emit("Pass", "Boot configuration OK", "0", bootCfg)

    const summ = await this.run1(s, "show install summary")
    this.emit("Pass", "Install summary: " + (this.installInfo(summ) || "No packages found"), "0", summ)
    this.emit("Completed", "Environment verification completed", "0", "See the rows above for each check")
  }

  private installInfo(summ: string) {
    return ["Active", "Inactive", "Committed"].map((k) => { const m = new RegExp(`${k}:\\s+(.+)`).exec(summ); return m ? `${k}: ${m[1].trim()}` : "" }).filter(Boolean).join(", ")
  }

  private async upload(s: SshSession) {
    const filename = flashName(this.iosFile)
    const size = fs.statSync(this.iosFile).size
    this.startedAt = Date.now()
    if (str(this.params.transferMethod, "ftp-builtin") === "scp") return this.uploadScp(s, filename, size)
    if (this.ftp) return this.uploadBuiltinFtp(s, filename, size)
    const cmd = `copy ftp://${this.ftpIp}/${baseName(this.iosFile)} flash:${filename}`
    this.transfer("Running", `FTP upload from ${this.ftpIp} -> ${filename}`, 0, size)
    let out = await s.sendTiming(cmd)
    if (out.includes("Destination filename")) out += await s.sendTiming(filename)
    if (/Bad filename|Error parsing filename/.test(out)) { this.transfer("Failed", `Filename error: ${filename}`, 0, size, out); return }
    // The copy keeps the session busy, so progress is read over a second session.
    let transferred = 0, last = -1, unchanged = 0
    const pattern = new RegExp(`\\d+\\s+-\\w+-?\\s+(\\d+)\\s+.*${filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i")
    while (Date.now() - this.startedAt < 50 * 60 * 1000) {
      if (this.ctx.stopRequested) { this.transfer("Failed", "Stopped by user during upload", transferred, size, out); return }
      await new Promise((r) => setTimeout(r, 5000))
      let dir = ""
      try {
        const probe = await openSession(this.ctx, this.device, this.params, "cisco_ios")
        try { dir = await probe.send(`dir flash: | include ${filename}`, { timeoutSec: 20 }) } finally { probe.close() }
      } catch (e) { out += `\n--- progress check failed: ${(e as Error).message}`; continue }
      const m = pattern.exec(dir)
      if (m) {
        transferred = Number(m[1])
        unchanged = transferred === last ? unchanged + 1 : 0
        last = transferred
        // The bar moves on every reading - the device's own file size is the only progress this mode has.
        this.transfer("Running", `Uploading: ${this.progressText(transferred, size)}`, transferred, size)
        if (transferred >= size || unchanged >= 3) break
      } else if (++unchanged >= 6) break
    }
    this.logCmd(cmd, out)
    if (transferred >= size) this.transfer("Completed", `IOS uploaded successfully (${mb(size)} MB in ${hms2((Date.now() - this.startedAt) / 1000)})`, size, size, out)
    else if (transferred > 0) this.transfer("Completed", `Transfer stopped growing at ${this.progressText(transferred, size)} - verify with Stage 2`, transferred, size, out)
    else this.transfer("Failed", "File not found on flash after the copy command", 0, size, out)
  }

  /** Built-in FTP: the app serves the image itself, so progress comes straight from the server's byte counter. */
  private async uploadBuiltinFtp(s: SshSession, filename: string, size: number) {
    const ftp = this.ftp!
    const cmd = `copy ftp://${ftp.user}:${ftp.password}@${this.ftpIp}/${ftp.fileName} flash:${filename}`
    const shown = cmd.replace(ftp.password, "****")
    this.transfer("Running", `Built-in FTP ${this.ftpIp}:${ftp.port} -> ${filename}`, 0, size)
    let out = await s.sendTiming(cmd, 2000, 20000)
    if (/Destination filename/i.test(out)) out += await s.sendTiming(filename, 2000, 20000)
    if (/over ?write|\[confirm\]/i.test(out)) out += await s.sendTiming("", 2000, 20000)
    const me = this.device.host.split(":")[0]
    // The bar is fed by the FTP server's own byte counter, so it moves every second while data flows.
    const ticker = setInterval(() => {
      const t = ftp.transfers.get(me) ?? [...ftp.transfers.values()].find((x) => !x.done)
      if (t && !t.done) this.transfer("Running", `Uploading: ${this.progressText(t.sent, size)}`, t.sent, size)
    }, 1000)
    try {
      // Small images finish while the prompts are still being answered - only wait when the copy is still running.
      if (!s.endsWithPrompt(out)) out += await s.waitForPrompt(60 * 60)
    } finally { clearInterval(ticker) }
    out = out.split(ftp.password).join("****")
    this.logCmd(shown, out)
    const copied = /(\d+) bytes copied/.exec(out)
    if (copied || /\[OK/.test(out)) {
      const sent = Number(copied?.[1] ?? size)
      this.transfer("Completed", `IOS uploaded via built-in FTP (${mb(sent)} MB in ${hms2((Date.now() - this.startedAt) / 1000)})`, sent, size, out)
      return
    }
    this.transfer("Failed", `FTP copy failed: ${await explainFtpFailure(ftp, out, this.device.host, this.ftpIp)}`, 0, size, out)
  }

  /** SCP push: the PC connects to the device, so nothing has to listen on the PC. */
  private async uploadScp(s: SshSession, filename: string, size: number) {
    let out = ""
    const cfg = await s.send("show running-config | include ip scp server", { timeoutSec: 60 })
    if (!/ip scp server enable/.test(cfg)) {
      out += await s.sendConfig(["ip scp server enable"])
      this.emit("Running", "Enabled 'ip scp server enable' on the device (it was off). Not saved to startup-config.", "0", out)
    }
    this.transfer("Running", `SCP push -> ${filename} (IOS SCP is slower than FTP)`, 0, size)
    const [host, port] = /^[^:]+:\d+$/.test(this.device.host) ? this.device.host.split(":") : [this.device.host, ""]
    let last = 0
    try {
      await scpPush({
        host, port: Number(port) || 22, username: str(this.params.username), password: str(this.params.password),
        localFile: this.iosFile, remotePath: `flash:${filename}`, shouldStop: () => this.ctx.stopRequested,
        onProgress: (sent) => {
          if (Date.now() - last < 1000) return // one update a second is enough for a bar
          last = Date.now()
          this.transfer("Running", `Uploading: ${this.progressText(sent, size)}`, sent, size)
        },
      })
      this.logCmd(`scp ${baseName(this.iosFile)} -> flash:${filename}`, out + "\nSCP transfer completed")
      this.transfer("Completed", `IOS uploaded via SCP (${mb(size)} MB in ${hms2((Date.now() - this.startedAt) / 1000)}) - verify with Stage 2`, size, size, out)
    } catch (e) {
      this.logCmd(`scp -> flash:${filename}`, `${out}\n${(e as Error).message}`, "Failed")
      this.transfer("Failed", `SCP failed: ${(e as Error).message}`, 0, size, out)
    }
  }

  private async verifyMd5(s: SshSession) {
    this.emit("Running", "Calculating local MD5 hash...")
    const local = await md5Of(this.iosFile)
    this.emit("Running", `Local MD5: ${local}`)
    const out = await this.run1(s, `verify /md5 flash:${flashName(this.iosFile)}`, 900)
    const dev = /([a-fA-F0-9]{32})/.exec(out)?.[1]?.toLowerCase()
    const cmp = `MD5 Comparison:\nLocal : ${local}\nDevice: ${dev ?? "(not found)"}\nMatch : ${dev === local}\n\n${out}`
    if (dev === local) this.emit("Completed", `MD5 verified successfully - ${local.slice(0, 8)}...`, "0", cmp)
    else this.emit("Failed", dev ? `MD5 mismatch - Local: ${local.slice(0, 8)}..., Device: ${dev.slice(0, 8)}...` : "Could not extract the device MD5", "0", cmp)
  }

  private async install(s: SshSession) {
    const filename = flashName(this.iosFile)
    const method = str(this.params.installMethod, "reload")
    let out = ""
    if (method === "install") {
      out += await s.sendConfig(["boot system switch all flash:packages.conf"])
      out += await s.saveConfig()
      const cmd = `install add file flash:${filename} activate commit prompt-level none`
      out += await s.send(cmd, { timeoutSec: 2400 }).catch((e) => `\n[session ended while installing - the device is probably reloading: ${e.message}]`)
      this.logCmd(cmd, out)
      this.emit("Completed", "Install command issued (install mode)", "0", out)
      return
    }
    out += await s.sendConfig([`boot system flash:${filename}`])
    out += await s.saveConfig()
    if (method === "reload") {
      out += await s.sendTiming("reload", 2500, 15000)
      if (/\[yes\/no\]/i.test(out)) out += await s.sendTiming("no", 2500, 15000)
      out += await s.sendTiming("", 2500, 10000).catch(() => "\n[reload confirmed - session closed]")
      this.emit("Completed", "Boot variable set and reload issued", "0", out)
    } else this.emit("Completed", "Boot variable updated (no reload)", "0", out)
    this.logCmd(`boot system flash:${filename}`, out)
  }

  private async checkStatus(s: SshSession) {
    const out = await this.run1(s, "show version")
    const ver = /Version\s+([^,\s]+)/.exec(out)?.[1] ?? "unknown"
    if (out.includes("ROM:") || /uptime is/i.test(out)) this.emit("Completed", `Device is up - running ${ver}`, "0", out)
    else this.emit("Failed", "Installation may have failed", "0", out)
  }

  private async verifyServices(s: SshSession) {
    const outs: string[] = []
    for (const cmd of ["show interfaces", "show ip interface brief", "show processes cpu"]) outs.push(`--- ${cmd} ---\n${await this.run1(s, cmd, 120)}`)
    const summ = await this.run1(s, "show install summary")
    outs.push(`--- show install summary ---\n${summ}`, `--- Install Status ---\n${this.installInfo(summ) || "No packages found"}`)
    const down = (outs[1].match(/\s(administratively down|down)\s/g) ?? []).length
    this.emit("Completed", `Services verified${down ? ` (${down} interface line(s) down)` : ""}`, "0", outs.join("\n"))
  }

  // --------------------------------------------------------------------- flash cleanup
  /** Ask what "install remove inactive" would delete, then answer no. Nothing is removed. */
  private async listInactive(s: SshSession) { await this.installRemove(s, false) }

  /** Delete the inactive images. The file list is in the results and the log before the answer is given. */
  private async removeInactive(s: SshSession) { await this.installRemove(s, true) }

  private async freeBytes(s: SshSession): Promise<number> {
    const out = await this.run1(s, "dir flash:", 120).catch(() => "")
    return Number(/(\d+)\s+bytes free/.exec(out)?.[1] ?? 0)
  }

  private async installRemove(s: SshSession, remove: boolean) {
    const cmd = "install remove inactive"
    const freeBefore = await this.freeBytes(s)
    this.emit("Running", remove ? "Looking for inactive images to delete..." : "Listing inactive images - nothing will be deleted")
    // The device scans flash (minutes on a stack) and then either asks the question or comes straight back.
    let out = await s.sendUntil(cmd, QUESTION, 15 * 60)
    if (/Invalid input|Incomplete command|Unknown command|Ambiguous command/i.test(out)) {
      this.logCmd(cmd, out, "Failed")
      this.emit("Failed", "This device does not support 'install remove inactive' - it needs IOS-XE in install mode. " +
        "In bundle mode, free space by deleting the old image with 'delete flash:<file>'.", "0", out)
      return
    }
    const files = parseInactiveFiles(out)
    const asked = QUESTION.test(out)
    if (!asked && !files.length) {
      this.logCmd(cmd, out, "Completed")
      this.emit("Completed", `Nothing to clean up - no inactive images on flash (${mb(freeBefore)}MB free)`, "0", out)
      return
    }
    // Every file gets its own row, so the list can be read (and exported) before anything is deleted.
    for (const file of files.slice(0, MAX_FILE_ROWS)) this.emit(remove ? "Deleting" : "Will be deleted", file)
    if (files.length > MAX_FILE_ROWS) this.emit("Info", `... and ${files.length - MAX_FILE_ROWS} more file(s) - full list in Output`)

    if (!remove) {
      if (asked) out += "\n" + (await s.send("n", { timeoutSec: 120 }))
      this.logCmd(cmd, out, "Listed")
      this.emit("Completed", `${files.length} file(s) can be deleted. Nothing was deleted - use "Cleanup: remove inactive images" ` +
        "to free the space.", "0", out)
      return
    }
    // Deleting and the post-remove cleanup that follows it can take a few minutes on a stack.
    out += "\n" + (await s.send("y", { timeoutSec: 20 * 60 }))
    const freeAfter = await this.freeBytes(s)
    const freed = Math.max(0, freeAfter - freeBefore)
    const failed = /FAILED|%\s*Error/i.test(out) && !/SUCCESS/i.test(out)
    this.logCmd(cmd, out, failed ? "Failed" : "Completed")
    if (failed) { this.emit("Failed", "install remove inactive did not finish cleanly - read the output before retrying", "0", out); return }
    this.emit("Completed", `${files.length} file(s) deleted, ${mb(freed)}MB freed (${mb(freeAfter)}MB free now)`, String(freed), out)
  }
}

export const upgradeIos: ToolDef = {
  id: "upgrade-ios", name: "IOS Upgrade", category: "SSH Tools", order: 15, icon: "upload",
  description: "Multi-stage Cisco IOS/IOS-XE upgrade: verify environment, FTP upload, MD5 check, install, post-checks. Run the stages in order.",
  fields: [
    { name: "iosFile", label: "IOS image file", type: "path", kind: "file", required: true, placeholder: "Click Browse, or paste the full path",
      browseTitle: "Select the IOS image", browseFilter: "IOS images (*.bin;*.tar;*.img;*.pkg)|*.bin;*.tar;*.img;*.pkg|All files (*.*)|*.*",
      help: "The file stays where it is on this PC - nothing is copied. With 'External FTP server' the same file must also be in that server's root." },
    ...INVENTORY_FIELDS,
    { name: "username", label: "Username", type: "text", required: true, width: "half", defaultFrom: "username", remember: true },
    { name: "password", label: "Password", type: "password", required: true, width: "half", remember: true },
    { name: "deviceType", label: "Device type", type: "select", default: "cisco_ios", options: "deviceTypes", width: "half" },
    { name: "installMethod", label: "Installation method", type: "select", default: "reload", width: "half",
      options: [{ value: "reload", label: "Reload (boot system + reload)" }, { value: "boot", label: "Boot variable change only" },
        { value: "install", label: "Install mode (install add ... activate commit)" }] },
    { name: "transferMethod", label: "Transfer method (Stage 1)", type: "select", default: "ftp-builtin",
      options: [{ value: "ftp-builtin", label: "Built-in FTP server - started automatically (recommended)" },
        { value: "scp", label: "SCP push - nothing listens on this PC (slower; enables 'ip scp server')" },
        { value: "ftp-external", label: "External FTP server - already running (FileZilla, IIS, ...)" }],
      help: "Built-in FTP listens on port 21 only while Stage 1 runs, with a one-time password, and serves only the selected image. Allow Node.js in the Windows firewall prompt the first time." },
    { name: "ftpIp", label: "FTP server IP (this PC)", type: "text", width: "half", defaultFrom: "localIp",
      showIf: { transferMethod: "ftp-builtin" }, help: "Address of this PC as seen by the devices. Auto-detected from the default route; edit it if the devices reach this PC on another interface." },
    { name: "ftpIpExternal", label: "External FTP server IP", type: "text", width: "half", defaultFrom: "localIp",
      showIf: { transferMethod: "ftp-external" }, help: "Anonymous FTP, or configure 'ip ftp username / password' on the devices." },
    { name: "threads", label: "Max parallel sessions", type: "number", default: 3, min: 1, max: 10, width: "half" },
  ],
  columns: COLUMNS,
  session: true,
  runs: [
    { id: "stage0", label: "Stage 0: Verify Environment", params: { stage: 0 } },
    { id: "stage1", label: "Stage 1: Upload IOS", params: { stage: 1 } },
    { id: "stage2", label: "Stage 2: Verify MD5", params: { stage: 2 } },
    { id: "stage3", label: "Stage 3: Install Image", params: { stage: 3 }, danger: true,
      confirm: "WARNING: this installs the new IOS image on ALL selected devices. Devices will reload and service will be interrupted. Proceed?" },
    { id: "stage4", label: "Stage 4: Check Status", params: { stage: 4 } },
    { id: "stage5", label: "Stage 5: Verify Services", params: { stage: 5 } },
    // Flash cleanup. Listing needs no image file and deletes nothing, so it is safe to press at any time.
    { id: "cleanup-list", label: "Cleanup: list inactive images", params: { stage: 6 }, optionalFields: ["iosFile"] },
    { id: "cleanup-remove", label: "Cleanup: remove inactive images", params: { stage: 7 }, optionalFields: ["iosFile"], danger: true,
      confirm: "This runs 'install remove inactive' on ALL selected devices and answers yes: the inactive IOS package files are " +
        "deleted from flash to free space. Files in use by the running image are never touched, and the device does not reload. " +
        "Run 'Cleanup: list inactive images' first to see exactly which files will be deleted. Proceed?" },
  ],
  async run(ctx, params) {
    const stage = Math.min(7, Math.max(0, Number(params.stage) || 0))
    const iosFile = str(params.iosFile).trim().replace(/^"|"$/g, "")
    // The cleanup runs work on what is already on flash - they need no image on this PC.
    if (stage <= 5 && (!fs.existsSync(iosFile) || !fs.statSync(iosFile).isFile())) { ctx.error(`IOS image file not found: ${iosFile}`); return }
    const devices = await devicesFor(ctx, params)
    if (!devices.length) return
    // One upgrade = one session: every stage writes into the same folder and keeps the rows of the stages
    // before it, until the user presses Done.
    const session = openRunSession(this.id)
    ctx.setRunDir(session.dir)
    ctx.setColumns(COLUMNS)
    for (const row of session.rows) ctx.addRow(row)
    const before = ctx.rows().length
    ctx.info(session.runs.length
      ? `Session ${path.basename(session.dir)} - continuing after ${session.runs.map((r) => r.label).join(", ")}.`
      : `Session ${path.basename(session.dir)} started. Every stage logs into this folder until you press Done.`)
    ctx.summary(`${stageLabel(stage)} - ${STAGES[stage]}: ${devices.length} device(s)`)
    const method = str(params.transferMethod, "ftp-builtin")
    const ftpIp = (method === "ftp-external" ? str(params.ftpIpExternal) : str(params.ftpIp)).trim() || localIp()
    let ftp: SingleFileFtpServer | null = null
    if (stage === 1 && method === "ftp-builtin") {
      ftp = new SingleFileFtpServer(iosFile, flashName(iosFile))
      try { await ftp.start(Number(process.env.ONSITE_FTP_PORT) || 21) } catch (e) { ctx.error((e as Error).message); return }
      ctx.info(`Built-in FTP server started on ${ftpIp}:${ftp.port} for this run (read-only, one-time password, serves only ${ftp.fileName}).`)
    }
    // Stage 1 measures its progress in bytes, not in devices: the bar at the top of the results is the
    // transfer itself, which is the only thing happening for the next minutes or hours.
    const sentBy = new Map<string, number>()
    let onBytes: ((host: string, sent: number) => void) | undefined
    if (stage === 1) {
      ctx.progress(0, fs.statSync(iosFile).size * devices.length)
      onBytes = (host, sent) => {
        sentBy.set(host, sent)
        ctx.progress([...sentBy.values()].reduce((a, b) => a + b, 0))
      }
    }
    try {
      await ctx.mapParallel(devices, (d) => new Stage(ctx, params, d, stage, iosFile, ftpIp, ftp, onBytes).run(),
        num(params.threads, 3), stage !== 1)
    } finally {
      if (ftp) { await ftp.stop(); ctx.log("Built-in FTP server stopped") }
    }
    // Only the rows this stage produced count towards its result - the rows above it belong to earlier stages.
    const rows = ctx.rows().slice(before)
    appendRun(session, stageLabel(stage), COLUMNS, rows)
    const failed = rows.filter((r) => ["Failed", "Error"].includes(String(r.Status))).length
    const completed = rows.filter((r) => r.Status === "Completed").length
    ctx.summary(`${stageLabel(stage)} - ${STAGES[stage]}: ${completed} completed, ${failed} failed check(s), ${devices.length} device(s)`)
    if (failed) ctx.warn(`${stageLabel(stage)} finished with ${failed} failed check(s). Review the results before continuing.`)
    else ctx.info(`${stageLabel(stage)} (${STAGES[stage]}) finished for ${devices.length} device(s).`)
  },
}
