/**
 * Things the server does on the desktop of the PC it runs on: the Browse dialog and opening a folder in Explorer.
 * Both only make sense for a browser on that same PC - in --lan mode the window would open on the wrong screen.
 */
import { spawn } from "node:child_process"
import fs from "node:fs"

/** A browser on this PC: loopback Host, and no proxy in front saying the request came from elsewhere. */
export function isLocalRequest(req: Request): boolean {
  const fwd = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim().replace(/^::ffff:/, "")
  const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "")
  return (!fwd || fwd === "127.0.0.1" || fwd === "::1") && ["127.0.0.1", "localhost", "[::1]"].includes(host)
}

/** Open `dir` in Explorer / Finder / the file manager. The folder must exist; the caller decides which folders are allowed. */
export function openFolder(dir: string): void {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`Folder not found: ${dir}`)
  const [cmd, args] = process.platform === "win32" ? ["explorer.exe", [dir]]
    : process.platform === "darwin" ? ["open", [dir]] : ["xdg-open", [dir]]
  // Explorer exits with 1 even when it opened the window, so the exit code says nothing - only a failed start does.
  const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: false })
  child.on("error", () => undefined)
  child.unref()
}
