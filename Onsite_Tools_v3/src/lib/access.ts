/**
 * Access key for --lan mode. On 127.0.0.1 only this PC can reach the app, so there is nothing to check. With
 * --lan anyone on the network could otherwise push config or reload devices, so scripts/start-lan.mjs sets
 * ONSITE_ACCESS_KEY and every request must carry it: once as ?key=... (the link run.bat opens and the console
 * prints), after that as an http-only cookie. The client IP is not used - Host and X-Forwarded-For are
 * whatever the caller sends.
 */
import { createHash, timingSafeEqual } from "node:crypto"

export const ACCESS_COOKIE = "onsite_key"
export const accessKey = () => process.env.ONSITE_ACCESS_KEY?.trim() || ""

const digest = (s: string) => createHash("sha256").update(s).digest()
export const sameKey = (given: string | undefined | null, key: string) =>
  !!given && !!key && timingSafeEqual(digest(given), digest(key))

export type AccessDecision =
  | { kind: "allow" }
  /** Right key in the URL: store it in the cookie and drop it from the address bar. */
  | { kind: "remember"; cleanUrl: URL }
  | { kind: "deny"; api: boolean }

export function decideAccess(url: URL, cookie: string | undefined, key: string): AccessDecision {
  if (!key) return { kind: "allow" }
  if (sameKey(url.searchParams.get("key"), key)) {
    const cleanUrl = new URL(url)
    cleanUrl.searchParams.delete("key")
    return { kind: "remember", cleanUrl }
  }
  if (sameKey(cookie, key)) return { kind: "allow" }
  return { kind: "deny", api: url.pathname.startsWith("/api/") }
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** Plain page - the app's own layout and scripts are behind the gate too. */
export function keyPage(path: string, wrong: boolean): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Onsite Tools - access key</title>
<style>body{font:15px system-ui,sans-serif;background:#f6f6f7;color:#111;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box}
@media(prefers-color-scheme:dark){body{background:#111;color:#eee}input{background:#222;color:#eee;border-color:#444}}
form{max-width:380px;width:100%}h1{font-size:20px}p{color:#777}input{width:100%;box-sizing:border-box;padding:10px;font:inherit;border:1px solid #ccc;border-radius:6px}
button{margin-top:12px;padding:10px 16px;font:inherit;border:0;border-radius:6px;background:#2563eb;color:#fff;cursor:pointer}.err{color:#dc2626}</style></head>
<body><form method="get" action="${escapeHtml(path)}"><h1>Onsite Tools</h1>
<p>This app runs in LAN mode. Enter the access key shown in the run.bat window on the PC that runs it.</p>
${wrong ? '<p class="err">That key is not right.</p>' : ""}
<input name="key" type="password" autocomplete="off" autofocus required aria-label="Access key"><button type="submit">Open</button></form></body></html>`
}
