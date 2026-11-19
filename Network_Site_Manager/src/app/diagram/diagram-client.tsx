"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { BrickWall, Download, Maximize2, Network, RadioTower, RotateCcw, Router, Server, Wifi, type LucideIcon } from "lucide-react"
import { Badge } from "@astryxdesign/core/Badge"
import { Button } from "@astryxdesign/core/Button"
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput"
import { Selector } from "@astryxdesign/core/Selector"
import { DataTable, Td } from "@/components/data-table"
import { Panel } from "@/components/page-header"
import { shortIfName } from "@/lib/config-parser"
import type { Topology, TopologyNode } from "@/lib/topology"
import { ROLE_LABEL, type DeviceRole } from "@/lib/types"
import { NODE_H, NODE_W, SEG_H, SEG_W, layoutGraph, type Positions } from "./layout-graph"

const ROLE_STYLE: Record<DeviceRole, { color: string; icon: LucideIcon }> = {
  ROUTER: { color: "#6366f1", icon: Router },
  FIREWALL: { color: "#dc2626", icon: BrickWall },
  CORE_SWITCH: { color: "#0891b2", icon: Network },
  ACCESS_SWITCH: { color: "#16a34a", icon: Server },
  WLC: { color: "#d97706", icon: RadioTower },
  ACCESS_POINT: { color: "#a855f7", icon: Wifi },
  OTHER: { color: "#64748b", icon: Server },
}

type View = { x: number; y: number; w: number; h: number }

const posKey = (site: string) => `diagram-pos:${site}`

function readSaved(site: string): Positions | null {
  try {
    const s = window.localStorage.getItem(posKey(site))
    return s ? (JSON.parse(s) as Positions) : null
  } catch { return null }
}

function boundsOf(pos: Positions): View {
  const pts = Object.values(pos)
  if (!pts.length) return { x: 0, y: 0, w: 800, h: 400 }
  const pad = 80
  const minX = Math.min(...pts.map((p) => p.x)) - SEG_W / 2 - pad
  const maxX = Math.max(...pts.map((p) => p.x)) + SEG_W / 2 + pad
  const minY = Math.min(...pts.map((p) => p.y)) - NODE_H / 2 - pad
  const maxY = Math.max(...pts.map((p) => p.y)) + NODE_H / 2 + pad
  return { x: minX, y: minY, w: Math.max(maxX - minX, 400), h: Math.max(maxY - minY, 300) }
}

/** Point just outside a w x h box centred on c, along the direction to `to`. */
function edgePoint(c: { x: number; y: number }, to: { x: number; y: number }, w: number, h: number, extra: number) {
  const dx = to.x - c.x, dy = to.y - c.y
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len, uy = dy / len
  const d = Math.min(ux ? w / 2 / Math.abs(ux) : Infinity, uy ? h / 2 / Math.abs(uy) : Infinity)
  return { x: c.x + ux * (d + extra), y: c.y + uy * (d + extra) }
}

function ifList(names: (string | null)[]) {
  const s = names.filter((n): n is string => !!n).map(shortIfName)
  if (s.length <= 2) return s.join(", ")
  return `${s[0]} +${s.length - 1}`
}

export function DiagramClient({ sites, siteCode, topology, configCount }: {
  sites: { code: string; name: string; configCount: number }[]
  siteCode: string
  topology: Topology
  configCount: number
}) {
  const router = useRouter()
  const svgRef = React.useRef<SVGSVGElement>(null)
  const [showSegments, setShowSegments] = React.useState(true)
  const [showLabels, setShowLabels] = React.useState(true)
  const [selected, setSelected] = React.useState<string | null>(null)
  const [pos, setPos] = React.useState<Positions>(() => layoutGraph(topology, true))
  const [view, setView] = React.useState<View>(() => boundsOf(pos))
  const drag = React.useRef<{ kind: "node" | "pan"; id?: string; sx: number; sy: number; cx: number; cy: number; ox: number; oy: number; moved: boolean } | null>(null)

  // Restore this viewer's arrangement after mount (localStorage does not exist on the server).
  React.useEffect(() => {
    const saved = readSaved(siteCode)
    if (!saved) return
    const merged = { ...layoutGraph(topology, true), ...saved }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time restore of a browser-only value
    setPos(merged)
    setView(boundsOf(merged))
  }, [siteCode, topology])

  const save = React.useCallback((p: Positions) => {
    try { window.localStorage.setItem(posKey(siteCode), JSON.stringify(p)) } catch { /* private mode etc. */ }
  }, [siteCode])

  // Wheel zoom needs a non-passive listener to stop the page scrolling.
  React.useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const pt = toSvg(e.clientX, e.clientY)
      const k = e.deltaY > 0 ? 1.12 : 1 / 1.12
      setView((v) => {
        const w = Math.min(Math.max(v.w * k, 200), 20000)
        const h = v.h * (w / v.w)
        return { x: pt.x - (pt.x - v.x) * (w / v.w), y: pt.y - (pt.y - v.y) * (h / v.h), w, h }
      })
    }
    svg.addEventListener("wheel", onWheel, { passive: false })
    return () => svg.removeEventListener("wheel", onWheel)
  })

  function toSvg(clientX: number, clientY: number) {
    const svg = svgRef.current!
    const ctm = svg.getScreenCTM()
    if (!ctm) return { x: 0, y: 0 }
    const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse())
    return { x: p.x, y: p.y }
  }

  const onPointerDown = (e: React.PointerEvent, id?: string) => {
    e.stopPropagation()
    const p = toSvg(e.clientX, e.clientY)
    const o = id ? pos[id] : { x: view.x, y: view.y }
    drag.current = { kind: id ? "node" : "pan", id, sx: p.x, sy: p.y, cx: e.clientX, cy: e.clientY, ox: o.x, oy: o.y, moved: false }
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    if (Math.abs(e.clientX - d.cx) + Math.abs(e.clientY - d.cy) > 3) d.moved = true
    if (d.kind === "node" && d.id) {
      const p = toSvg(e.clientX, e.clientY)
      setPos((prev) => ({ ...prev, [d.id!]: { x: d.ox + p.x - d.sx, y: d.oy + p.y - d.sy } }))
    } else if (d.kind === "pan") {
      // Measured in screen pixels: panning moves the view, so an SVG-space delta would chase itself.
      const rect = svgRef.current!.getBoundingClientRect()
      setView((v) => ({ ...v, x: d.ox - ((e.clientX - d.cx) * v.w) / rect.width, y: d.oy - ((e.clientY - d.cy) * v.h) / rect.height }))
    }
  }
  const onPointerUp = () => {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (d.kind === "node" && d.id) {
      if (!d.moved) setSelected((s) => (s === d.id ? null : d.id!))
      else save(pos)
    } else if (!d.moved) setSelected(null)
  }

  const resetLayout = () => {
    const p = layoutGraph(topology, showSegments)
    setPos(p)
    setView(boundsOf(p))
    try { window.localStorage.removeItem(posKey(siteCode)) } catch { /* ignore */ }
  }

  const downloadSvg = () => {
    const svg = svgRef.current
    if (!svg) return
    const b = boundsOf(Object.fromEntries(Object.entries(pos).filter(([id]) => showSegments || !id.startsWith("seg:"))))
    const clone = svg.cloneNode(true) as SVGSVGElement
    clone.setAttribute("viewBox", `${b.x} ${b.y} ${b.w} ${b.h}`)
    clone.setAttribute("width", String(Math.round(b.w)))
    clone.setAttribute("height", String(Math.round(b.h)))
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg")
    const css = getComputedStyle(document.documentElement)
    // CSS variables mean nothing outside this page; bake in the current theme's values.
    const text = new XMLSerializer().serializeToString(clone).replace(/var\((--[\w-]+)\)/g, (_, v: string) => css.getPropertyValue(v).trim() || "#888")
    const url = URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }))
    const a = document.createElement("a")
    a.href = url
    a.download = `${siteCode}-diagram.svg`
    a.click()
    URL.revokeObjectURL(url)
  }

  const node = topology.nodes.find((n) => n.id === selected) ?? null
  const segNodes = showSegments ? topology.segments : []

  return (
    <>
      <Panel>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-72">
            <Selector label="Site" value={siteCode} onChange={(v) => router.push(`/diagram?site=${encodeURIComponent(v)}`)}
              options={sites.map((s) => ({ value: s.code, label: `${s.code} · ${s.name} (${s.configCount} config)` }))} />
          </div>
          <CheckboxInput label="แสดง LAN segment" value={showSegments} onChange={setShowSegments} />
          <CheckboxInput label="แสดงชื่อ interface" value={showLabels} onChange={setShowLabels} />
          <div className="ml-auto flex flex-wrap gap-2">
            <Button variant="ghost" size="sm" label="Fit" icon={<Maximize2 className="h-3.5 w-3.5" />} onClick={() => setView(boundsOf(pos))} />
            <Button variant="ghost" size="sm" label="Reset layout" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={resetLayout} />
            <Button variant="secondary" size="sm" label="Download SVG" icon={<Download className="h-3.5 w-3.5" />} isDisabled={!topology.nodes.length} onClick={downloadSvg} />
          </div>
        </div>
      </Panel>

      {configCount === 0 ? (
        <Panel>
          <p className="text-sm">
            Site <span className="font-mono font-semibold">{siteCode}</span> ยังไม่มี config{" "}
            <Link className="text-primary underline" href={`/import?site=${siteCode}`}>ไปที่ Import configuration</Link> เพื่ออัปโหลด running-config ของอุปกรณ์ก่อน
          </p>
        </Panel>
      ) : (
        <Panel className="!p-0 overflow-hidden">
          <svg
            ref={svgRef}
            role="img"
            aria-label={`Network diagram of ${siteCode}`}
            viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
            className="block h-[620px] w-full cursor-grab touch-none select-none active:cursor-grabbing"
            style={{ background: "var(--card)" }}
            onPointerDown={(e) => onPointerDown(e)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          >
            <rect x={view.x - 50000} y={view.y - 50000} width={100000} height={100000} fill="var(--card)" />

            {/* segment links first, so devices draw over them */}
            {segNodes.flatMap((s) => s.members.map((m) => {
              const a = pos[m.node], b = pos[s.id]
              if (!a || !b) return null
              // No text label: several members converge on one segment and their labels piled up.
              // The address is in the tooltip and in the device's interface table.
              return (
                <g key={`${s.id}-${m.node}-${m.ifName}`}>
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--muted-foreground)" strokeWidth={1.2} strokeDasharray="3 4" opacity={0.7} />
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="transparent" strokeWidth={10}>
                    <title>{`${m.node} ${shortIfName(m.ifName)} · ${m.ip} → ${s.label}`}</title>
                  </line>
                </g>
              )
            }))}

            {topology.links.map((l) => {
              const a = pos[l.a], b = pos[l.b]
              if (!a || !b) return null
              const la = edgePoint(a, b, NODE_W, NODE_H, 16)
              const lb = edgePoint(b, a, NODE_W, NODE_H, 16)
              const evidence = l.sources.includes("subnet")
              return (
                <g key={l.id}>
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--foreground)" strokeWidth={l.pairs.length > 1 ? 3.5 : 2} opacity={evidence ? 0.75 : 0.55} />
                  {l.pairs.length > 1 && <Label x={(a.x + b.x) / 2} y={(a.y + b.y) / 2} text={`×${l.pairs.length}`} strong />}
                  {showLabels && <Label x={la.x} y={la.y} text={ifList(l.pairs.map((p) => p.aIf))} />}
                  {showLabels && <Label x={lb.x} y={lb.y} text={ifList(l.pairs.map((p) => p.bIf))} />}
                  <title>{`${l.a} ↔ ${l.b}\n${l.pairs.map((p) => `${p.aIf ?? "?"} ↔ ${p.bIf ?? "?"}`).join("\n")}\nจาก: ${l.sources.map((s) => (s === "subnet" ? "IP วงเดียวกัน" : "interface description")).join(", ")}`}</title>
                </g>
              )
            })}

            {segNodes.map((s) => {
              const p = pos[s.id]
              if (!p) return null
              return (
                <g key={s.id} transform={`translate(${p.x - SEG_W / 2} ${p.y - SEG_H / 2})`} className="cursor-move" onPointerDown={(e) => onPointerDown(e, s.id)}>
                  <rect width={SEG_W} height={SEG_H} rx={SEG_H / 2} fill="var(--muted)" stroke="var(--muted-foreground)" strokeDasharray="4 3" />
                  <text x={SEG_W / 2} y={SEG_H / 2 + 4} textAnchor="middle" fontSize={11} fill="var(--foreground)" fontFamily="ui-monospace, monospace">{s.label}</text>
                </g>
              )
            })}

            {topology.nodes.map((n) => {
              const p = pos[n.id]
              if (!p) return null
              const st = ROLE_STYLE[n.role]
              const Icon = st.icon
              const isSel = selected === n.id
              return (
                <g key={n.id} transform={`translate(${p.x - NODE_W / 2} ${p.y - NODE_H / 2})`} className="cursor-pointer" onPointerDown={(e) => onPointerDown(e, n.id)}>
                  <rect width={NODE_W} height={NODE_H} rx={10} fill="var(--card)" stroke={isSel ? "var(--primary)" : st.color}
                    strokeWidth={isSel ? 3 : 1.6} strokeDasharray={n.imported ? undefined : "5 4"} />
                  <rect width={6} height={NODE_H} rx={3} fill={st.color} opacity={n.imported ? 1 : 0.4} />
                  <Icon x={14} y={NODE_H / 2 - 10} width={20} height={20} color={st.color} />
                  <text x={42} y={24} fontSize={13} fontWeight={600} fill="var(--foreground)">{n.hostname.length > 18 ? `${n.hostname.slice(0, 17)}…` : n.hostname}</text>
                  <text x={42} y={42} fontSize={11} fill="var(--muted-foreground)" fontFamily="ui-monospace, monospace">{n.imported ? (n.mgmtIp ?? ROLE_LABEL[n.role]) : "ยังไม่ได้ Import"}</text>
                  <title>{`${n.hostname} · ${ROLE_LABEL[n.role]}${n.mgmtIp ? ` · ${n.mgmtIp}` : ""}`}</title>
                </g>
              )
            })}
          </svg>
          <div className="border-border text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-2 text-xs">
            {(Object.keys(ROLE_STYLE) as DeviceRole[]).filter((r) => topology.nodes.some((n) => n.role === r)).map((r) => (
              <span key={r} className="flex items-center gap-1.5"><span className="inline-block size-2.5 rounded-full" style={{ background: ROLE_STYLE[r].color }} />{ROLE_LABEL[r]}</span>
            ))}
            <span>กรอบเส้นประ = อุปกรณ์ที่ถูกอ้างถึงแต่ยังไม่ได้ Import config</span>
            <span>เส้นหนา ×N = หลาย link ระหว่างคู่เดียวกัน</span>
            <span className="ml-auto">{topology.nodes.length} อุปกรณ์ · {topology.links.length} link · {topology.segments.length} segment</span>
          </div>
        </Panel>
      )}

      {node && <NodeDetails node={node} onClose={() => setSelected(null)} siteCode={siteCode} />}
      {configCount > 0 && !node && <p className="text-muted-foreground text-xs">คลิกที่อุปกรณ์เพื่อดูรายละเอียด interface</p>}
    </>
  )
}

function Label({ x, y, text, muted = false, strong = false }: { x: number; y: number; text: string; muted?: boolean; strong?: boolean }) {
  if (!text) return null
  return (
    <text x={x} y={y + 4} textAnchor="middle" fontSize={strong ? 12 : 10} fontWeight={strong ? 700 : 500}
      fill={muted ? "var(--muted-foreground)" : "var(--foreground)"} stroke="var(--card)" strokeWidth={4} paintOrder="stroke"
      fontFamily="ui-monospace, monospace" style={{ pointerEvents: "none" }}>
      {text}
    </text>
  )
}

function NodeDetails({ node, onClose, siteCode }: { node: TopologyNode; onClose: () => void; siteCode: string }) {
  const [all, setAll] = React.useState(false)
  const ifs = all ? node.interfaces : node.interfaces.filter((i) => i.address || i.description || i.mode === "trunk")
  return (
    <Panel
      title={<span className="flex items-center gap-2">{node.hostname} <Badge variant={node.imported ? "green" : "neutral"} label={node.imported ? "Imported" : "ยังไม่ได้ Import"} /></span>}
      actions={<><Button variant="ghost" size="sm" label={all ? "เฉพาะที่สำคัญ" : `ทุก interface (${node.interfaces.length})`} onClick={() => setAll(!all)} isDisabled={!node.imported} /><Button variant="ghost" size="sm" label="Close" onClick={onClose} /></>}
    >
      <dl className="mb-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm md:grid-cols-4">
        <div><dt className="text-muted-foreground text-xs">Role</dt><dd>{ROLE_LABEL[node.role]}</dd></div>
        <div><dt className="text-muted-foreground text-xs">Mgmt IP</dt><dd className="font-mono">{node.mgmtIp ?? "—"}</dd></div>
        <div><dt className="text-muted-foreground text-xs">Platform</dt><dd>{node.platform ?? "—"}</dd></div>
        <div><dt className="text-muted-foreground text-xs">Version</dt><dd className="font-mono">{node.version ?? "—"}</dd></div>
      </dl>
      {node.imported ? (
        <DataTable head={["Interface", "Description", "IP address", "Mode", "VLAN", "State"]} empty={ifs.length === 0}>
          {ifs.map((i) => (
            <tr key={i.name}>
              <Td mono>{i.name}</Td>
              <Td>{i.description ?? "—"}</Td>
              <Td mono>{i.address ?? "—"}</Td>
              <Td>{i.mode ?? "—"}</Td>
              <Td mono>{i.vlan ?? "—"}</Td>
              <Td>{i.shutdown ? <span className="text-muted-foreground">shutdown</span> : "up"}</Td>
            </tr>
          ))}
        </DataTable>
      ) : (
        <p className="text-sm">อุปกรณ์นี้ถูกอ้างถึงใน description ของอุปกรณ์อื่น <Link className="text-primary underline" href={`/import?site=${siteCode}`}>Import config ของ {node.hostname}</Link> เพื่อให้ Diagram ครบ</p>
      )}
    </Panel>
  )
}
