import { NextResponse, type NextRequest } from "next/server"
import { ACCESS_COOKIE, accessKey, decideAccess, keyPage } from "@/lib/access"

/** --lan mode gate; see src/lib/access.ts. Does nothing when the app listens on 127.0.0.1 only. */
export function proxy(req: NextRequest) {
  const key = accessKey()
  const decision = decideAccess(req.nextUrl, req.cookies.get(ACCESS_COOKIE)?.value, key)
  if (decision.kind === "allow") return NextResponse.next()
  if (decision.kind === "remember") {
    const res = NextResponse.redirect(decision.cleanUrl)
    res.cookies.set(ACCESS_COOKIE, key, { httpOnly: true, sameSite: "strict", path: "/", maxAge: 60 * 60 * 24 * 30 })
    return res
  }
  if (decision.api) return NextResponse.json({ error: "Access key required (LAN mode)." }, { status: 401 })
  return new NextResponse(keyPage(req.nextUrl.pathname, req.nextUrl.searchParams.has("key")), {
    status: 401, headers: { "content-type": "text/html; charset=utf-8" },
  })
}

export const config = {
  // Static build output carries no data; everything else - pages, API, server actions - is gated.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
}
