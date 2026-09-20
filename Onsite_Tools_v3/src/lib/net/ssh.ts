/**
 * Interactive SSH driver for network devices (the Node replacement for netmiko).
 *
 * Opens a shell channel, learns the prompt, disables paging and then runs commands by
 * writing a line and reading until the prompt comes back.
 */
import { Client, type ClientChannel, type ConnectConfig } from "ssh2"

export const DEVICE_TYPES = [
  "autodetect", "cisco_ios", "cisco_xe", "cisco_nxos", "cisco_xr", "cisco_asa", "cisco_wlc", "arista_eos",
  "huawei", "hp_comware", "hp_procurve", "aruba_os", "juniper_junos", "fortinet", "linux", "generic",
] as const
export type DeviceType = (typeof DEVICE_TYPES)[number] | string

const PAGING: Record<string, string[]> = {
  cisco_ios: ["terminal length 0", "terminal width 511"],
  cisco_xe: ["terminal length 0", "terminal width 511"],
  cisco_nxos: ["terminal length 0", "terminal width 511"],
  cisco_xr: ["terminal length 0", "terminal width 511"],
  cisco_asa: ["terminal pager 0"],
  cisco_wlc: ["config paging disable"],
  arista_eos: ["terminal length 0", "terminal width 32767"],
  huawei: ["screen-length 0 temporary"],
  hp_comware: ["screen-length disable"],
  hp_procurve: ["no page"],
  aruba_os: ["no paging"],
  juniper_junos: ["set cli screen-length 0", "set cli screen-width 511"],
  fortinet: [],
  linux: [],
  generic: [],
}
/** Tried in order by "autodetect" until one is accepted by the device. */
const AUTODETECT_ORDER: [string, string][] = [
  ["cisco_ios", "terminal length 0"],
  ["huawei", "screen-length 0 temporary"],
  ["hp_comware", "screen-length disable"],
  ["juniper_junos", "set cli screen-length 0"],
  ["hp_procurve", "no page"],
]
const REJECTED = /% ?(invalid|unknown|incomplete|ambiguous|unrecognized)|unrecognized command|unknown command|error:|syntax error|invalid input/i

// Old IOS / switches still only offer SHA-1 key exchange, CBC ciphers and ssh-rsa host keys.
export const LEGACY_ALGORITHMS: ConnectConfig["algorithms"] = {
  kex: { append: ["diffie-hellman-group14-sha1", "diffie-hellman-group-exchange-sha1", "diffie-hellman-group1-sha1"], prepend: [], remove: [] },
  cipher: { append: ["aes128-cbc", "aes192-cbc", "aes256-cbc", "3des-cbc"], prepend: [], remove: [] },
  serverHostKey: { append: ["ssh-rsa", "ssh-dss"], prepend: [], remove: [] },
  hmac: { append: ["hmac-sha1", "hmac-md5"], prepend: [], remove: [] },
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b[=>]|\x08|\x07/g
const PROMPT_END = /[>#\]$%]\s*$/

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** "SW-CORE-01(config-if)#" -> "SW-CORE-01" */
export function hostnameFromPrompt(prompt: string): string {
  return prompt.trim().replace(/^[<\[]/, "").replace(/[>#\]$%]\s*$/, "").replace(/\(.*\)$/, "").replace(/^.*@/, "").trim()
}

/** Matches the device prompt in any mode (exec, enable, config sub-modes) at the end of the buffer. */
export function promptRegex(prompt: string): RegExp {
  const host = hostnameFromPrompt(prompt)
  if (!host) return /[>#\]$%]\s*$/
  return new RegExp(`(?:^|[\\r\\n])[<\\[]?(?:[\\w.-]+@)?${escapeRegExp(host)}[^\\r\\n]{0,60}[>#\\]$%]\\s*$`)
}

/** Remove the echoed command (first line) and the trailing prompt (last line). */
export function cleanOutput(raw: string, command: string): string {
  let text = raw.replace(ANSI, "").replace(/\r\n/g, "\n").replace(/\r/g, "")
  const lines = text.split("\n")
  if (lines.length && lines[0].trim().endsWith(command.trim())) lines.shift()
  if (lines.length && PROMPT_END.test(lines[lines.length - 1])) lines.pop()
  text = lines.join("\n")
  return text.replace(/^\n+|\s+$/g, "")
}

export class AuthError extends Error {}

export function classifyError(err: unknown): string {
  const msg = String((err as Error)?.message ?? err).toLowerCase()
  if (err instanceof AuthError || msg.includes("authentication") || msg.includes("auth fail")) return "Authentication failed."
  if (msg.includes("timed out") || msg.includes("timeout")) return "Connection timeout"
  return "Connection Error"
}

export interface SshOptions {
  host: string
  username: string
  password: string
  deviceType?: DeviceType
  port?: number
  timeoutSec?: number
  secret?: string
}

export class SshSession {
  private client = new Client()
  private channel!: ClientChannel
  private buffer = ""
  private waiter: (() => void) | null = null
  private closed = false
  prompt = ""
  hostname = ""
  detectedType = "generic"

  constructor(private opts: SshOptions) {}

  static async open(opts: SshOptions): Promise<SshSession> {
    const s = new SshSession(opts)
    await s.connect()
    return s
  }

  private connect(): Promise<void> {
    const timeout = (this.opts.timeoutSec ?? 20) * 1000
    return new Promise((resolve, reject) => {
      let settled = false
      const fail = (e: Error) => { if (!settled) { settled = true; this.close(); reject(e) } }
      this.client
        .on("ready", () => {
          this.client.shell({ term: "vt100", cols: 511, rows: 1000 }, (err, channel) => {
            if (err) return fail(err)
            this.channel = channel
            channel.on("data", (d: Buffer) => { this.buffer += d.toString("utf8"); this.waiter?.() })
            channel.stderr.on("data", (d: Buffer) => { this.buffer += d.toString("utf8"); this.waiter?.() })
            channel.on("close", () => { this.closed = true; this.waiter?.() })
            this.prepare().then(() => { settled = true; resolve() }, fail)
          })
        })
        .on("keyboard-interactive", (_n, _i, _l, prompts, finish) => finish(prompts.map(() => this.opts.password)))
        .on("error", (e: Error & { level?: string }) =>
          fail(e.level === "client-authentication" ? new AuthError("Authentication failed.") : e))
        .connect({
          host: this.opts.host,
          port: this.opts.port ?? 22,
          username: this.opts.username,
          password: this.opts.password,
          tryKeyboard: true,
          readyTimeout: timeout,
          keepaliveInterval: 15000,
          algorithms: LEGACY_ALGORITHMS,
        })
    })
  }

  /** Wait until `test(buffer)` is true, the channel closes, or the timeout hits. */
  private readUntil(test: (buf: string) => boolean, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null
        reject(new Error(`Read timeout after ${Math.round(timeoutMs / 1000)}s. Last output: ${this.buffer.slice(-200).replace(ANSI, "")}`))
      }, timeoutMs)
      const check = () => {
        const clean = this.buffer.replace(ANSI, "")
        if (test(clean) || this.closed) {
          clearTimeout(timer)
          this.waiter = null
          const out = this.buffer
          this.buffer = ""
          resolve(out)
        }
      }
      this.waiter = check
      check()
    })
  }

  private write(line: string) {
    if (this.closed) throw new Error("SSH channel is closed")
    this.channel.write(line + "\n")
  }

  private async prepare() {
    // banner + first prompt
    await this.readUntil((b) => PROMPT_END.test(b), 15000).catch(() => "")
    this.write("")
    const echo = await this.readUntil((b) => PROMPT_END.test(b), 10000)
    const lines = echo.replace(ANSI, "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    this.prompt = lines[lines.length - 1] ?? ""
    this.hostname = hostnameFromPrompt(this.prompt)

    if (this.opts.secret && this.prompt.endsWith(">")) await this.enable(this.opts.secret)

    const wanted = (this.opts.deviceType || "autodetect").toLowerCase()
    if (wanted === "autodetect") {
      for (const [type, cmd] of AUTODETECT_ORDER) {
        const out = await this.send(cmd, { timeoutSec: 10 }).catch(() => "% error")
        if (!REJECTED.test(out)) {
          this.detectedType = type
          for (const extra of (PAGING[type] ?? []).slice(1)) await this.send(extra, { timeoutSec: 10 }).catch(() => "")
          return
        }
      }
      this.detectedType = "generic"
      return
    }
    this.detectedType = wanted
    for (const cmd of PAGING[wanted] ?? PAGING.cisco_ios) await this.send(cmd, { timeoutSec: 10 }).catch(() => "")
  }

  private async enable(secret: string) {
    this.write("enable")
    await this.readUntil((b) => /assword:\s*$/i.test(b) || PROMPT_END.test(b), 10000)
    this.write(secret)
    const out = await this.readUntil((b) => PROMPT_END.test(b), 10000)
    const last = out.replace(ANSI, "").trim().split(/\r?\n/).pop() ?? ""
    if (last) this.prompt = last.trim()
  }

  /** Run one command and return its output (echo and prompt removed). */
  async send(command: string, o: { timeoutSec?: number; expect?: RegExp } = {}): Promise<string> {
    const re = o.expect ?? promptRegex(this.prompt)
    this.buffer = ""
    this.write(command)
    const raw = await this.readUntil((b) => re.test(b), (o.timeoutSec ?? 60) * 1000)
    return cleanOutput(raw, command)
  }

  /** True when `text` already ends with the device prompt (the command has finished). */
  endsWithPrompt(text: string): boolean {
    return promptRegex(this.prompt).test(text.replace(/\s+$/, ""))
  }

  /** Wait for the prompt to come back after a long-running interactive command (e.g. "copy"). */
  async waitForPrompt(timeoutSec: number): Promise<string> {
    const re = promptRegex(this.prompt)
    const raw = await this.readUntil((b) => re.test(b), timeoutSec * 1000)
    return raw.replace(ANSI, "").replace(/\r/g, "")
  }

  /** Write a line and collect whatever arrives until the device goes quiet (for interactive prompts). */
  async sendTiming(line: string, quietMs = 2500, maxMs = 30000): Promise<string> {
    this.buffer = ""
    this.write(line)
    const start = Date.now()
    let last = -1
    while (Date.now() - start < maxMs) {
      await new Promise((r) => setTimeout(r, quietMs))
      if (this.buffer.length === last || this.closed) break
      last = this.buffer.length
    }
    const out = this.buffer.replace(ANSI, "").replace(/\r/g, "")
    this.buffer = ""
    return out
  }

  async configMode(): Promise<string> {
    const cmd = this.detectedType === "huawei" || this.detectedType === "hp_comware" ? "system-view" : "configure terminal"
    return this.send(cmd, { timeoutSec: 15 })
  }

  async exitConfigMode(): Promise<string> {
    const cmd = this.detectedType === "huawei" || this.detectedType === "hp_comware" ? "return" : "end"
    return this.send(cmd, { timeoutSec: 15 })
  }

  async sendConfig(lines: string[]): Promise<string> {
    let out = (await this.configMode()) + "\n"
    for (const l of lines) out += `${l}\n${await this.send(l, { timeoutSec: 30 })}\n`
    out += await this.exitConfigMode()
    return out
  }

  async saveConfig(): Promise<string> {
    const cmd = this.detectedType === "huawei" ? "save" : "write memory"
    const out = await this.sendTiming(cmd, 3000, 60000)
    if (/\[y\/n\]|\(y\/n\)|confirm/i.test(out)) return out + (await this.sendTiming("y", 3000, 60000))
    return out
  }

  close() {
    this.closed = true
    try { this.channel?.end() } catch { /* ignore */ }
    try { this.client.end() } catch { /* ignore */ }
  }
}
