/**
 * IOS Upgrade - multi-stage Cisco IOS / IOS-XE upgrade. Each stage is a separate run so the results can be
 * reviewed in between. An FTP server serving the image must be started manually (FileZilla Server, IIS, ...).
 */
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { JobContext } from "../jobs"
import type { ToolDevice } from "../inventory"
import { SshSession } from "../net/ssh"
import { hms } from "../paths"
import { localIp } from "../settings"
import { devicesFor, openSession } from "./common"
import { INVENTORY_FIELDS, num, str, type Params, type ToolDef } from "./types"

const STAGES = ["Verify Environment", "Upload IOS", "Verify MD5", "Install Image", "Check Status", "Verify Services"]
const COLUMNS = ["Stage", "Host", "Hostname", "Status", "Message", "Bytes Transferred", "Output", "Timestamp"]

function md5Of(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("md5")
    fs.createReadStream(file).on("data", (c) => h.update(c)).on("end", () => resolve(h.digest("hex"))).on("error", reject)
  })
}

/** Cisco "copy" refuses some characters in the destination name. */
export const flashName = (file: string) => path.basename(file).replace(/[_ ]/g, "-")

class Stage {
  hostname: string
  constructor(private ctx: JobContext, private params: Params, private device: ToolDevice, private stage: number,
              private iosFile: string, private ftpIp: string) {
    this.hostname = device.hostname || "Unknown"
  }

  private emit(status: string, message: string, bytes = "0", output = "") {
    this.ctx.addRow({ Stage: `Stage ${this.stage}`, Host: this.device.host, Hostname: this.hostname, Status: status, Message: message,
      "Bytes Transferred": bytes, Output: output, Timestamp: hms() })
  }

  private logCmd(command: string, output: string, status = "Completed") {
    try {
      fs.appendFileSync(path.join(this.ctx.runDir, `stage_${this.stage}_${this.device.host}_${this.hostname}.log`),
        `\n${"=".repeat(80)}\nTimestamp: ${new Date().toLocaleString("sv-SE")}\nHost: ${this.device.host}\nHostname: ${this.hostname}\n` +
        `Stage: Stage ${this.stage}\nStatus: ${status}\nCommand: ${command}\nOutput:\n${output}\n${"=".repeat(80)}\n`, "utf8")
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
      await [this.verifyEnvironment, this.upload, this.verifyMd5, this.install, this.checkStatus, this.verifyServices][this.stage].call(this, s)
    } catch (e) {
      this.emit("Failed", `Stage ${this.stage} failed: ${(e as Error).message}`, "0", String((e as Error).stack ?? e))
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
    const cmd = `copy ftp://${this.ftpIp}/${path.basename(this.iosFile)} flash:${filename}`
    this.emit("Running", `Starting FTP upload of ${filename} from ${this.ftpIp} (${size.toLocaleString()} bytes)`)
    let out = await s.sendTiming(cmd)
    if (out.includes("Destination filename")) out += await s.sendTiming(filename)
    if (/Bad filename|Error parsing filename/.test(out)) { this.emit("Failed", `Filename error: ${filename}`, "0", out); return }
    // The copy keeps the session busy, so progress is read over a second session.
    const started = Date.now()
    let transferred = 0, last = -1, unchanged = 0, lastMsg = 0
    const pattern = new RegExp(`\\d+\\s+-\\w+-?\\s+(\\d+)\\s+.*${filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i")
    while (Date.now() - started < 50 * 60 * 1000) {
      if (this.ctx.stopRequested) { this.emit("Failed", "Stopped by user during upload", transferred.toLocaleString(), out); return }
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
        if (transferred >= size || unchanged >= 3) break
        if (Date.now() - lastMsg > 15000) {
          this.emit("Running", `Uploading ${filename}: ${transferred.toLocaleString()}/${size.toLocaleString()} bytes (${Math.min(100, Math.round((transferred / size) * 100))}%)`, transferred.toLocaleString(), dir)
          lastMsg = Date.now()
        }
      } else if (++unchanged >= 6) break
    }
    this.logCmd(cmd, out)
    if (transferred >= size) this.emit("Completed", `IOS uploaded successfully (${size.toLocaleString()} bytes)`, size.toLocaleString(), out)
    else if (transferred > 0) this.emit("Completed", `Transfer stopped growing at ${transferred.toLocaleString()}/${size.toLocaleString()} bytes - verify with Stage 2`, transferred.toLocaleString(), out)
    else this.emit("Failed", "File not found on flash after the copy command", "0", out)
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
}

export const upgradeIos: ToolDef = {
  id: "upgrade-ios", name: "IOS Upgrade", category: "SSH Tools", order: 15, icon: "upload",
  description: "Multi-stage Cisco IOS/IOS-XE upgrade: verify environment, FTP upload, MD5 check, install, post-checks. Run the stages in order.",
  fields: [
    { name: "iosFile", label: "IOS image file (path on this PC)", type: "path", kind: "file", required: true, placeholder: "C:\\ftp\\cat9k_iosxe.17.09.05.SPA.bin",
      help: "The same file must be in the FTP server root." },
    ...INVENTORY_FIELDS,
    { name: "username", label: "Username", type: "text", required: true, width: "half", defaultFrom: "username", remember: true },
    { name: "password", label: "Password", type: "password", required: true, width: "half", remember: true },
    { name: "deviceType", label: "Device type", type: "select", default: "cisco_ios", options: "deviceTypes", width: "half" },
    { name: "installMethod", label: "Installation method", type: "select", default: "reload", width: "half",
      options: [{ value: "reload", label: "Reload (boot system + reload)" }, { value: "boot", label: "Boot variable change only" },
        { value: "install", label: "Install mode (install add ... activate commit)" }] },
    { name: "ftpIp", label: "FTP server IP (this PC)", type: "text", width: "half", defaultFrom: "localIp",
      help: "Auto-detected; edit if the devices reach this PC on another address." },
    { name: "threads", label: "Max parallel sessions", type: "number", default: 3, min: 1, max: 10, width: "half" },
  ],
  columns: COLUMNS,
  runs: [
    { id: "stage0", label: "Stage 0: Verify Environment", params: { stage: 0 } },
    { id: "stage1", label: "Stage 1: Upload IOS", params: { stage: 1 },
      notice: "Before Stage 1, start an FTP server manually (FileZilla Server, IIS, ...):\n1. FTP root = the folder containing the IOS file\n2. Allow anonymous, or configure 'ip ftp username/password' on the devices\n3. The devices must reach this PC on the FTP IP shown in the form" },
    { id: "stage2", label: "Stage 2: Verify MD5", params: { stage: 2 } },
    { id: "stage3", label: "Stage 3: Install Image", params: { stage: 3 }, danger: true,
      confirm: "WARNING: this installs the new IOS image on ALL selected devices. Devices will reload and service will be interrupted. Proceed?" },
    { id: "stage4", label: "Stage 4: Check Status", params: { stage: 4 } },
    { id: "stage5", label: "Stage 5: Verify Services", params: { stage: 5 } },
  ],
  async run(ctx, params) {
    const stage = Math.min(5, Math.max(0, Number(params.stage) || 0))
    const iosFile = str(params.iosFile).trim().replace(/^"|"$/g, "")
    if (!fs.existsSync(iosFile) || !fs.statSync(iosFile).isFile()) { ctx.error(`IOS image file not found: ${iosFile}`); return }
    const devices = await devicesFor(ctx, params)
    if (!devices.length) return
    ctx.setColumns(COLUMNS)
    ctx.summary(`Stage ${stage} - ${STAGES[stage]}: ${devices.length} device(s)`)
    const ftpIp = str(params.ftpIp).trim() || localIp()
    await ctx.mapParallel(devices, (d) => new Stage(ctx, params, d, stage, iosFile, ftpIp).run(), num(params.threads, 3))
    const rows = ctx.rows()
    const failed = rows.filter((r) => ["Failed", "Error"].includes(String(r.Status))).length
    const completed = rows.filter((r) => r.Status === "Completed").length
    ctx.summary(`Stage ${stage} - ${STAGES[stage]}: ${completed} completed, ${failed} failed check(s), ${devices.length} device(s)`)
    if (failed) ctx.warn(`Stage ${stage} finished with ${failed} failed check(s). Review the results before continuing.`)
    else ctx.info(`Stage ${stage} (${STAGES[stage]}) finished for ${devices.length} device(s).`)
  },
}
