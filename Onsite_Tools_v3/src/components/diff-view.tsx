"use client"

import * as React from "react"
import { parseUnified, type DiffRow } from "@/lib/diff-format"

/**
 * Two backups of the same device have almost the same path, so a truncated full path shows the same text on
 * both sides. The folder and file name are what tell them apart - the whole path stays in the tooltip.
 */
const shortPath = (p?: string) => {
  if (!p) return p
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : p
}

/** Left file pink, right file green, the missing half of a pair greyed out - one table, so the two sides cannot drift. */
const CELL: Record<DiffRow["type"], { left: string; right: string }> = {
  same: { left: "", right: "" },
  chg: { left: "bg-red-500/15", right: "bg-green-500/15" },
  del: { left: "bg-red-500/15", right: "bg-muted/60" },
  add: { left: "bg-muted/60", right: "bg-green-500/15" },
  gap: { left: "", right: "" },
}

function Side({ side, tone, divider }: { side: DiffRow["left"]; tone: string; divider?: boolean }) {
  return (
    <>
      <td className={`text-muted-foreground border-r px-2 text-right align-top tabular-nums select-none ${divider ? "border-l-2" : ""} ${tone}`}
        >
        {side?.no ?? ""}
      </td>
      {/* Each pane keeps its half of the window; a line longer than that is cut here and kept whole in the .diff file. */}
      <td className={`overflow-hidden px-2 align-top text-ellipsis whitespace-pre ${tone}`} title={side?.text}>{side?.text ?? ""}</td>
    </>
  )
}

/**
 * Side-by-side view of a unified diff: before on the left, after on the right, line numbers on both.
 * Only the changed parts are shown unless the run was made with "whole file".
 */
export function DiffView({ text, leftName, rightName }: { text: string; leftName?: string; rightName?: string }) {
  const [onlyChanges, setOnlyChanges] = React.useState(false)
  const rows = React.useMemo(() => parseUnified(text), [text])
  const shown = onlyChanges ? rows.filter((r) => r.type !== "same") : rows
  const changes = rows.filter((r) => r.type !== "same" && r.type !== "gap").length
  const numberWidth = 52

  if (!rows.length) return <pre className="max-h-[65vh] overflow-auto font-mono text-xs whitespace-pre">{text}</pre>

  return (
    <div className="text-[12px]">
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <span className="text-muted-foreground">
          <b>{changes}</b> changed line(s) · <span className="bg-red-500/20 px-1">before</span> <span className="bg-green-500/20 px-1">after</span>
        </span>
        <span className="flex-1" />
        <label className="flex cursor-pointer items-center gap-1.5 text-xs select-none">
          <input type="checkbox" checked={onlyChanges} onChange={(e) => setOnlyChanges(e.target.checked)} />
          Hide unchanged lines
        </label>
      </div>
      <div className="max-h-[65vh] overflow-auto rounded-lg border font-mono">
        <table className="w-full table-fixed border-collapse">
          <colgroup>
            <col style={{ width: numberWidth }} />
            <col />
            <col style={{ width: numberWidth }} />
            <col />
          </colgroup>
          <thead>
            <tr className="bg-muted sticky top-0 z-[1]">
              <th className="border-r border-b px-2 py-1" />
              <th className="max-w-0 truncate border-b px-2 py-1 text-left font-semibold" title={leftName}>{shortPath(leftName) ?? "Before"}</th>
              <th className="border-r border-l-2 border-b px-2 py-1" />
              <th className="max-w-0 truncate border-b px-2 py-1 text-left font-semibold" title={rightName}>{shortPath(rightName) ?? "After"}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row, i) =>
              row.type === "gap" ? (
                <tr key={i} className="bg-muted/40 text-muted-foreground">
                  <td className="border-y px-2 py-0.5 text-center select-none" colSpan={4}>
                    ⋯ {row.skipped ? `${row.skipped} unchanged line(s)` : "unchanged lines"} ⋯
                  </td>
                </tr>
              ) : (
                <tr key={i}>
                  <Side side={row.left} tone={CELL[row.type].left} />
                  <Side side={row.right} tone={CELL[row.type].right} divider />
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
