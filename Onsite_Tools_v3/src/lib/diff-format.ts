/**
 * Turn a unified diff back into rows for a side-by-side view: what the left file has next to what the
 * right file has, aligned line for line, the way MobaDiff / WinMerge show it.
 *
 * No React here on purpose - the parsing is pure and unit-tested, the component only draws it.
 */
export interface DiffSide { no: number; text: string }
export interface DiffRow {
  /** "same" both sides equal · "chg" replaced · "del" only on the left · "add" only on the right · "gap" skipped lines */
  type: "same" | "chg" | "del" | "add" | "gap"
  left?: DiffSide
  right?: DiffSide
  /** For a gap row: how many unchanged lines the diff left out. */
  skipped?: number
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

export function parseUnified(text: string): DiffRow[] {
  const rows: DiffRow[] = []
  let leftNo = 0, rightNo = 0, seenHunk = false
  let dels: DiffSide[] = [], adds: DiffSide[] = []

  // A run of removed lines followed by a run of added lines is one replacement, paired line by line.
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      const left = dels[i], right = adds[i]
      rows.push({ type: left && right ? "chg" : left ? "del" : "add", left, right })
    }
    dels = []
    adds = []
  }

  for (const raw of text.split(/\r?\n/)) {
    const hunk = HUNK.exec(raw)
    if (hunk) {
      flush()
      const nextLeft = Number(hunk[1])
      if (seenHunk) rows.push({ type: "gap", skipped: Math.max(0, nextLeft - leftNo - 1) })
      seenHunk = true
      leftNo = nextLeft - 1
      rightNo = Number(hunk[3]) - 1
      continue
    }
    if (!seenHunk || raw === "") continue
    const body = raw.slice(1)
    if (raw[0] === "-") { dels.push({ no: ++leftNo, text: body }); continue }
    if (raw[0] === "+") { adds.push({ no: ++rightNo, text: body }); continue }
    flush()
    rows.push({ type: "same", left: { no: ++leftNo, text: body }, right: { no: ++rightNo, text: body } })
  }
  flush()
  return rows
}

/** True when a cell holds a unified diff rather than ordinary text. */
export const looksLikeDiff = (text: string) => HUNK.test(text) || /\n@@ -\d+/.test(text)
