import type { Metadata } from "next"
import { cookies, headers } from "next/headers"
import type { ThemeMode } from "@astryxdesign/core/theme"
import "./globals.css"
import { AppShell } from "@astryxdesign/core/AppShell"
import { ToastViewport } from "@astryxdesign/core/Toast"
import { AppSidebar } from "@/components/app-sidebar"
import { ThemeToggle } from "@/components/theme-toggle"
import { listSites } from "@/lib/data"
import { Providers } from "./providers"

export const metadata: Metadata = {
  title: "Network Site Manager",
  description: "Network devices, subnets and WAN links for every site the team looks after",
}

export const dynamic = "force-dynamic"

// Same shell as Lab_management / Onsite_Tools_v3: Astryx AppShell, theme from a
// cookie stamped on <html> before paint so dark mode never flashes white.
export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const cookieStore = await cookies()
  const themeCookie = cookieStore.get("theme")?.value
  const themeMode: ThemeMode = themeCookie === "dark" || themeCookie === "light" ? themeCookie : "system"
  const initialSystemDark = cookieStore.get("theme-sys")?.value === "dark"
  const defaultIsMobile = /Mobi|Android|iPhone|iPad/i.test((await headers()).get("user-agent") ?? "")
  const sites = (await listSites()).map((s) => ({ code: s.code, name: s.name }))

  return (
    <html lang="th" data-theme={themeMode === "system" ? undefined : themeMode} suppressHydrationWarning>
      <body className="antialiased">
        {themeMode === "system" && (
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
            <AppShell sideNav={<AppSidebar sites={sites} />} contentPadding={4} mobileNav={{ defaultIsMobile }}>
              <div className="mx-auto w-full max-w-[1400px]">
                <div className="mb-2 flex justify-end">
                  <div className="account-pill flex items-center gap-2 bg-card px-3 py-1">
                    <span className="text-muted-foreground text-xs">Sample data · no login yet</span>
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
