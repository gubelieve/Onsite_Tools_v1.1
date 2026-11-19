"use client"

import { usePathname } from "next/navigation"
import { Building2, FileUp, LayoutDashboard, Network, Server, Share2 } from "lucide-react"
import { SideNav, SideNavHeading, SideNavSection, SideNavItem } from "@astryxdesign/core/SideNav"

export interface SiteLink { code: string; name: string }

export function AppSidebar({ sites }: { sites: SiteLink[] }) {
  const pathname = usePathname()
  const selected = (href: string) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/"))

  return (
    <SideNav header={<SideNavHeading icon={<Network className="size-4" />} heading="Network Sites" headingHref="/" />}>
      <SideNavSection title="Overview">
        <SideNavItem label="Dashboard" icon={LayoutDashboard} href="/" isSelected={selected("/")} />
        <SideNavItem label="All sites" icon={Building2} href="/sites" isSelected={pathname === "/sites"} />
        <SideNavItem label="All devices" icon={Server} href="/devices" isSelected={selected("/devices")} />
      </SideNavSection>
      <SideNavSection title="Configuration">
        <SideNavItem label="Import configuration" icon={FileUp} href="/import" isSelected={selected("/import")} />
        <SideNavItem label="Diagram" icon={Share2} href="/diagram" isSelected={selected("/diagram")} />
      </SideNavSection>
      <SideNavSection title="Sites">
        {sites.map((s) => (
          <SideNavItem key={s.code} label={s.code} icon={Building2} href={`/sites/${s.code}`} isSelected={selected(`/sites/${s.code}`)} />
        ))}
      </SideNavSection>
    </SideNav>
  )
}
