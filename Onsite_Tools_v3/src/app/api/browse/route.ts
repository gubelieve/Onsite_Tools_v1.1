import { execFile } from "node:child_process"
import path from "node:path"
import { NextResponse } from "next/server"
import { BASE_DIR } from "@/lib/paths"

export const dynamic = "force-dynamic"

/**
 * Native "Browse" dialog. The app runs on the user's own PC, so the server can open the operating system's file
 * picker and hand back the full path - nothing is uploaded or copied (IOS images are ~1 GB).
 *
 * The dialog has to be forced to the foreground: the web server is not the active application, so Windows would
 * otherwise open it behind the browser - scripts/browse.ps1 does that part.
 * Only answered for requests that come from this PC: in --lan mode the dialog would open on the wrong screen.
 */
function isLocal(req: Request): boolean {
  const fwd = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim().replace(/^::ffff:/, "")
  const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "")
  return (!fwd || fwd === "127.0.0.1" || fwd === "::1") && ["127.0.0.1", "localhost", "[::1]"].includes(host)
}

const run = (cmd: string, args: string[], env: Record<string, string> = {}) => new Promise<string>((resolve, reject) => {
  execFile(cmd, args, { timeout: 10 * 60 * 1000, windowsHide: true, env: { ...process.env, ...env } }, (err, stdout) => {
    // zenity / osascript exit with 1 when the user presses Cancel
    if (err && !("code" in err && err.code === 1)) reject(err); else resolve(String(stdout).trim())
  })
})

let open = false

export async function POST(req: Request) {
  if (!isLocal(req)) return NextResponse.json({ error: "Browse only works in a browser on the PC that runs the app. Paste the path instead." }, { status: 403 })
  if (open) return NextResponse.json({ error: "A file dialog is already open - check the taskbar." }, { status: 409 })
  const body = (await req.json().catch(() => ({}))) as { kind?: string; title?: string; filter?: string; initial?: string }
  const folder = body.kind === "folder"
  // Dialog text is passed through environment variables, never spliced into the script.
  const title = String(body.title ?? "Select").slice(0, 120)
  const filter = /^[^|]+\|[^|]+(\|[^|]+\|[^|]+)*$/.test(body.filter ?? "") ? body.filter! : "All files (*.*)|*.*"
  const initial = typeof body.initial === "string" && body.initial.trim() ? path.dirname(body.initial.trim()) : ""
  open = true
  try {
    let picked = ""
    if (process.platform === "win32") {
      picked = await run("powershell.exe", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", path.join(BASE_DIR, "scripts", "browse.ps1")],
        { ONSITE_KIND: folder ? "folder" : "file", ONSITE_TITLE: title, ONSITE_FILTER: filter, ONSITE_INITIAL: initial })
    } else if (process.platform === "darwin") {
      picked = await run("osascript", ["-e", `POSIX path of (choose ${folder ? "folder" : "file"} with prompt "Select")`])
    } else {
      picked = await run("zenity", ["--file-selection", ...(folder ? ["--directory"] : []), `--title=${title}`])
    }
    return NextResponse.json({ path: picked || null })
  } catch (e) {
    return NextResponse.json({ error: `Could not open the file dialog: ${(e as Error).message}. Paste the path instead.` }, { status: 500 })
  } finally {
    open = false
  }
}
