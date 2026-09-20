/**
 * Windows Firewall diagnosis for the built-in FTP server.
 *
 * A device can only fetch the image if it may open a connection *to* this PC. Dismissing the firewall prompt once
 * leaves a permanent inbound Block rule for node.exe, and from then on every FTP copy fails with nothing in the
 * log to explain why - so when a copy fails without the device ever connecting, we look the rule up and say so.
 * Nothing here changes any rule: fixing the firewall needs administrator rights and is the user's decision.
 */
import { execFile } from "node:child_process"
import os from "node:os"

export interface FirewallBlock { rules: string[]; program: string }

const PS_QUERY = `
$me = $env:ONSITE_PROGRAM
Get-NetFirewallApplicationFilter |
  Where-Object { $_.Program -and ($_.Program -ieq $me -or $_.Program -ilike '*\\node.exe') } |
  ForEach-Object {
    $r = $_ | Get-NetFirewallRule
    if ($r.Direction -eq 'Inbound' -and $r.Action -eq 'Block' -and $r.Enabled -eq 'True') {
      '{0} [{1}]' -f $r.DisplayName, $r.Profile
    }
  } | Select-Object -Unique
`

/** Inbound Block rules that apply to the executable running this app. Empty on failure or on other platforms. */
export function inboundBlockRules(timeoutMs = 20000): Promise<FirewallBlock> {
  const program = process.execPath
  if (process.platform !== "win32") return Promise.resolve({ rules: [], program })
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", PS_QUERY],
      { timeout: timeoutMs, windowsHide: true, env: { ...process.env, ONSITE_PROGRAM: program } },
      (err, stdout) => {
        // Access-denied or a missing cmdlet must never turn into a second failure: just report nothing.
        const rules = err ? [] : String(stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
        resolve({ rules, program })
      })
  })
}

/** Every IPv4 address of this PC, so the message can show which interface to advertise instead. */
export function localAddresses(): string[] {
  return Object.entries(os.networkInterfaces())
    .flatMap(([name, list]) => (list ?? []).filter((a) => a.family === "IPv4" && !a.internal).map((a) => `${a.address} (${name})`))
}

/** What to tell the user when a device never reached the built-in FTP server. */
export async function noInboundHint(ftpIp: string, port: number): Promise<string> {
  const { rules, program } = await inboundBlockRules()
  const where = `${ftpIp}:${port}`
  if (rules.length) {
    return `The device never opened a connection to ${where}. Windows Firewall is blocking it: ${rules.join(", ")}. ` +
      `Remove that rule in "Windows Defender Firewall > Advanced settings > Inbound Rules" (look for node.exe) and allow ${program}, ` +
      `or switch Transfer method to "SCP push", which needs no inbound connection.`
  }
  return `The device never opened a connection to ${where}. Check that ${ftpIp} is the interface facing the device ` +
    `(this PC has ${localAddresses().join(", ") || "no external address"}), that an ACL or firewall on the way does not block TCP 21, ` +
    `and that Windows allows inbound connections to ${program}. "SCP push" avoids inbound connections entirely.`
}
