"use client"

import * as React from "react"
import { usePathname } from "next/navigation"
import {
  Activity, Cable, Camera, Cloud, FileText, Globe, History, LayoutDashboard, ListChecks, Package, Search, Settings,
  Share2, Shield, ShieldCheck, Terminal, Upload, Wrench, type LucideIcon,
} from "lucide-react"
import { SideNav, SideNavHeading, SideNavSection, SideNavItem } from "@astryxdesign/core/SideNav"

export interface MenuItem { href: string; title: string; group: string; icon: string }

const ICONS: Record<string, LucideIcon> = {
  terminal: Terminal, upload: Upload, search: Search, package: Package, share: Share2, activity: Activity, shield: Shield,
  "file-text": FileText, "shield-check": ShieldCheck, cloud: Cloud, cable: Cable, globe: Globe, camera: Camera,
}

export function AppSidebar({ tools, deviceCount }: { tools: MenuItem[]; deviceCount: number }) {
  const pathname = usePathname()
  const sections = React.useMemo(() => {
    const byGroup = new Map<string, MenuItem[]>()
    for (const t of tools) byGroup.set(t.group, [...(byGroup.get(t.group) ?? []), t])
    return [...byGroup].map(([group, items]) => ({ group, items }))
  }, [tools])
  const selected = (href: string) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/"))

  return (
    <SideNav header={<SideNavHeading icon={<Wrench className="size-4" />} heading="Onsite Tools" headingHref="/" />}>
      <SideNavSection title="Overview">
        <SideNavItem label="Dashboard" icon={LayoutDashboard} href="/" isSelected={selected("/")} />
        <SideNavItem label={`Site Inventory (${deviceCount})`} icon={ListChecks} href="/site-inventory" isSelected={selected("/site-inventory")} />
        <SideNavItem label="Run History" icon={History} href="/history" isSelected={selected("/history")} />
      </SideNavSection>
      {sections.map((s) => (
        <SideNavSection key={s.group} title={s.group}>
          {s.items.map((i) => (
            <SideNavItem key={i.href} label={i.title} icon={ICONS[i.icon] ?? Terminal} href={i.href} isSelected={selected(i.href)} />
          ))}
        </SideNavSection>
      ))}
      <SideNavSection title="Administration">
        <SideNavItem label="Settings" icon={Settings} href="/settings" isSelected={selected("/settings")} />
      </SideNavSection>
    </SideNav>
  )
}
