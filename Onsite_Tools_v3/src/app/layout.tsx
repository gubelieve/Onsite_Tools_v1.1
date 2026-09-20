import type { Metadata } from "next"
import { cookies, headers } from "next/headers"
import type { ThemeMode } from "@astryxdesign/core/theme"
import "./globals.css"
import { AppShell } from "@astryxdesign/core/AppShell"
import { ToastViewport } from "@astryxdesign/core/Toast"
import { AppSidebar, type MenuItem } from "@/components/app-sidebar"
import { ThemeToggle } from "@/components/theme-toggle"
import { Providers } from "./providers"
import { TOOLS } from "@/lib/tools"
import prisma from "@/lib/prisma"

export const metadata: Metadata = {
  title: "Onsite Tools",
  description: "Network onsite toolkit - runs locally, no login, local database",
}

// No login: the app is bound to 127.0.0.1 and belongs to whoever runs it on this PC.
export const dynamic = "force-dynamic"

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const cookieStore = await cookies()
  const themeCookie = cookieStore.get("theme")?.value
  const themeMode: ThemeMode = themeCookie === "dark" || themeCookie === "light" ? themeCookie : "system"
  const initialSystemDark = cookieStore.get("theme-sys")?.value === "dark"
  const defaultIsMobile = /Mobi|Android|iPhone|iPad/i.test((await headers()).get("user-agent") ?? "")

  const deviceCount = await prisma.device.count().catch(() => 0)
  const menu: MenuItem[] = TOOLS.map((t) => ({ href: `/tools/${t.id}`, title: t.name, group: t.category, icon: t.icon }))

  return (
    <html lang="en" data-theme={themeMode === "system" ? undefined : themeMode} suppressHydrationWarning>
      <body className="antialiased">
        {themeMode === "system" && (
          // Resolves "system" before first paint so a dark-mode user never sees a white flash.
          <div hidden>
            <script
              dangerouslySetInnerHTML={{
                __html:
                  "try{var e=document.documentElement,d=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';if(!e.dataset.theme){e.dataset.theme=d}document.cookie='theme-sys='+d+'; path=/; max-age=31536000; samesite=lax'}catch(t){}",
              }}
            />
          </div>
        )}
        <ToastViewport>
          <Providers initialMode={themeMode} initialSystemDark={initialSystemDark}>
            <AppShell sideNav={<AppSidebar tools={menu} deviceCount={deviceCount} />} contentPadding={4} mobileNav={{ defaultIsMobile }}>
              <div className="mx-auto w-full max-w-[1500px]">
                <div className="mb-2 flex justify-end">
                  <div className="account-pill flex items-center gap-2 bg-card px-3 py-1">
                    <span className="text-muted-foreground text-xs">Local mode · no login</span>
                    <ThemeToggle />
                  </div>
                </div>
                {children}
              </div>
            </AppShell>
          </Providers>
        </ToastViewport>
      </body>
    </html>
  )
}
