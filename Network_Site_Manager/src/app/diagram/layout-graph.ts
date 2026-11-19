import type { Topology } from "@/lib/topology"
import type { DeviceRole } from "@/lib/types"

// A layered layout: the WAN edge on top, the core in the middle, access and
// wireless below, LAN segments at the bottom — the way network diagrams are
// usually drawn, and stable from one import to the next.

export const NODE_W = 180
export const NODE_H = 58
export const SEG_W = 190
export const SEG_H = 34
// Wide enough that the two interface labels of a side-by-side link (e.g. a
// Po1 between two cores) do not run into each other.
const GAP_X = 110
const GAP_Y = 130

const LAYER: Record<DeviceRole, number> = {
  ROUTER: 0, FIREWALL: 1, CORE_SWITCH: 2, WLC: 3, ACCESS_SWITCH: 3, OTHER: 3, ACCESS_POINT: 4,
}

export type Positions = Record<string, { x: number; y: number }>

export function layoutGraph(t: Topology, withSegments: boolean): Positions {
  const rows = new Map<number, { id: string; w: number }[]>()
  for (const n of t.nodes) {
    const l = LAYER[n.role]
    rows.set(l, [...(rows.get(l) ?? []), { id: n.id, w: NODE_W }])
  }
  if (withSegments && t.segments.length) rows.set(9, t.segments.map((s) => ({ id: s.id, w: SEG_W })))

  const ordered = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r)
  const widths = ordered.map((r) => r.reduce((s, n) => s + n.w, 0) + GAP_X * (r.length - 1))
  const maxW = Math.max(0, ...widths)
  const pos: Positions = {}
  ordered.forEach((row, i) => {
    let x = (maxW - widths[i]) / 2
    for (const n of row) {
      pos[n.id] = { x: x + n.w / 2, y: i * GAP_Y + NODE_H / 2 }
      x += n.w + GAP_X
    }
  })
  return pos
}
