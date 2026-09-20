/** RFC-4180 CSV reader/writer. Cells may contain commas, quotes and line breaks (multi-line "command" cells). */

export type Row = Record<string, string>

export function parseCsvText(text: string): string[][] {
  const src = text.replace(/^﻿/, "")
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++ } else quoted = false
      } else cell += ch
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === ",") { row.push(cell); cell = "" }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++
      row.push(cell); cell = ""
      rows.push(row); row = []
    } else cell += ch
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row) }
  return rows
}

/** Header + rows as objects. Blank header cells and fully empty rows are dropped; values are trimmed. */
export function parseCsv(text: string): { fields: string[]; rows: Row[] } {
  const table = parseCsvText(text)
  if (!table.length) return { fields: [], rows: [] }
  const header = table[0].map((h) => h.trim())
  const fields = header.filter(Boolean)
  const rows: Row[] = []
  for (const line of table.slice(1)) {
    const row: Row = {}
    header.forEach((h, i) => { if (h) row[h] = (line[i] ?? "").trim() })
    if (Object.values(row).some((v) => v !== "")) rows.push(row)
  }
  return { fields, rows }
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "_")

/** Real column name matching one of the aliases (case-insensitive, spaces == underscores). */
export function findCol(fields: string[], ...aliases: string[]): string | null {
  const map = new Map(fields.map((f) => [norm(f), f]))
  for (const a of aliases) {
    const hit = map.get(norm(a))
    if (hit) return hit
  }
  return null
}

function cellOut(v: unknown): string {
  const s = v === null || v === undefined ? "" : Array.isArray(v) ? v.join("; ") : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** CSV text with a BOM so Excel opens UTF-8 (Thai) correctly. */
export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const lines = [columns.map(cellOut).join(",")]
  for (const r of rows) lines.push(columns.map((c) => cellOut(r[c])).join(","))
  return "﻿" + lines.join("\r\n") + "\r\n"
}
