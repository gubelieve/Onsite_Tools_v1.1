/** Minimal HTTP client for controller APIs: optional TLS verification (self-signed certs) and a cookie jar. */
import http from "node:http"
import https from "node:https"

export interface HttpResponse { status: number; headers: http.IncomingHttpHeaders; text: string; json: <T = unknown>() => T }

export class HttpSession {
  private cookies = new Map<string, string>()
  headers: Record<string, string> = {}

  constructor(private verifyTls = false) {}

  request(method: string, url: string, o: { headers?: Record<string, string>; body?: string | Buffer; timeoutSec?: number; basicAuth?: [string, string] } = {}): Promise<HttpResponse> {
    const u = new URL(url)
    const lib = u.protocol === "http:" ? http : https
    const headers: Record<string, string> = { ...this.headers, ...o.headers }
    if (this.cookies.size) headers["Cookie"] = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ")
    if (o.basicAuth) headers["Authorization"] = "Basic " + Buffer.from(o.basicAuth.join(":")).toString("base64")
    if (o.body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(o.body))
    return new Promise((resolve, reject) => {
      const req = lib.request(u, { method, headers, rejectUnauthorized: this.verifyTls, timeout: (o.timeoutSec ?? 60) * 1000 }, (res) => {
        const chunks: Buffer[] = []
        res.on("data", (c) => chunks.push(c))
        res.on("end", () => {
          for (const c of res.headers["set-cookie"] ?? []) {
            const [pair] = c.split(";")
            const i = pair.indexOf("=")
            if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim())
          }
          const text = Buffer.concat(chunks).toString("utf8")
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: <T,>() => JSON.parse(text) as T })
        })
      })
      req.on("timeout", () => req.destroy(new Error("Request timeout")))
      req.on("error", reject)
      if (o.body !== undefined) req.write(o.body)
      req.end()
    })
  }

  get(url: string, o: { timeoutSec?: number; query?: Record<string, string> } = {}) {
    const u = new URL(url)
    for (const [k, v] of Object.entries(o.query ?? {})) u.searchParams.set(k, v)
    return this.request("GET", u.toString(), { timeoutSec: o.timeoutSec })
  }

  postJson(url: string, payload: unknown, timeoutSec = 60) {
    return this.request("POST", url, { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), timeoutSec })
  }

  postForm(url: string, form: Record<string, string>, timeoutSec = 30) {
    return this.request("POST", url, { headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(), timeoutSec })
  }
}

export function baseUrl(input: string): string {
  const t = input.trim().replace(/\/+$/, "")
  return /^https?:\/\//i.test(t) ? t : `https://${t}`
}
