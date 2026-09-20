import { execFile } from "node:child_process"
import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

/**
 * Native "Browse" dialog. The app runs on the user's own PC, so the server can open the operating system's file
 * picker and hand back the full path - nothing is uploaded or copied (IOS images are ~1 GB).
 * Only answered for requests that come from this PC: in --lan mode the dialog would open on the wrong screen.
 */
function isLocal(req: Request): boolean {
  const fwd = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim().replace(/^::ffff:/, "")
  const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "")
  return (!fwd || fwd === "127.0.0.1" || fwd === "::1") && ["127.0.0.1", "localhost", "[::1]"].includes(host)
}

const run = (cmd: string, args: string[]) => new Promise<string>((resolve, reject) => {
  execFile(cmd, args, { timeout: 10 * 60 * 1000, windowsHide: true }, (err, stdout) => {
    // zenity / osascript exit with 1 when the user presses Cancel
    if (err && !("code" in err && err.code === 1)) reject(err); else resolve(String(stdout).trim())
  })
})

let open = false

export async function POST(req: Request) {
  if (!isLocal(req)) return NextResponse.json({ error: "Browse only works in a browser on the PC that runs the app. Paste the path instead." }, { status: 403 })
  if (open) return NextResponse.json({ error: "A file dialog is already open - check the taskbar." }, { status: 409 })
  const body = (await req.json().catch(() => ({}))) as { kind?: string; title?: string; filter?: string }
  const folder = body.kind === "folder"
  // Dialog text is passed through environment variables, never spliced into the script.
  const title = String(body.title ?? "Select").slice(0, 120)
  const filter = /^[^|]+\|[^|]+(\|[^|]+\|[^|]+)*$/.test(body.filter ?? "") ? body.filter! : "All files (*.*)|*.*"
  open = true
  try {
    let picked = ""
    if (process.platform === "win32") {
      const script = folder
        ? "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = $env:ONSITE_TITLE; " +
          "$o = New-Object System.Windows.Forms.Form -Property @{TopMost=$true}; if ($d.ShowDialog($o) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }"
        : "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.OpenFileDialog; $d.Title = $env:ONSITE_TITLE; $d.Filter = $env:ONSITE_FILTER; " +
          "$o = New-Object System.Windows.Forms.Form -Property @{TopMost=$true}; if ($d.ShowDialog($o) -eq 'OK') { [Console]::Out.Write($d.FileName) }"
      process.env.ONSITE_TITLE = title
      process.env.ONSITE_FILTER = filter
      picked = await run("powershell.exe", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", "[Console]::OutputEncoding=[Text.Encoding]::UTF8; " + script])
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
