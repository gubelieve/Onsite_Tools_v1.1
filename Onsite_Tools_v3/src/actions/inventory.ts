"use server"

import { revalidatePath } from "next/cache"
import { parseCsv, type Row } from "@/lib/csv"
import { deleteDevice, deleteList, importRows, upsertDevice, type DeviceInput } from "@/lib/inventory"

type Result<T> = { ok: true; data: T } | { ok: false; error: string }

async function guard<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    const data = await fn()
    revalidatePath("/", "layout")
    return { ok: true, data }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

async function readSheet(file: File): Promise<{ fields: string[]; rows: Row[] }> {
  if (/\.xlsx?$/i.test(file.name)) {
    const ExcelJS = (await import("exceljs")).default
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await file.arrayBuffer())
    const ws = wb.worksheets[0]
    if (!ws) throw new Error("The workbook has no sheet")
    const cell = (v: unknown): string =>
      (v === null || v === undefined ? "" : typeof v === "object" && "text" in (v as object) ? String((v as { text: unknown }).text) : String(v)).trim()
    const header = (ws.getRow(1).values as unknown[]).slice(1).map(cell)
    const rows: Row[] = []
    ws.eachRow((r, n) => {
      if (n === 1) return
      const values = (r.values as unknown[]).slice(1)
      const row: Row = {}
      header.forEach((h, i) => { if (h) row[h] = cell(values[i]) })
      if (Object.values(row).some(Boolean)) rows.push(row)
    })
    return { fields: header.filter(Boolean), rows }
  }
  return parseCsv(Buffer.from(await file.arrayBuffer()).toString("utf8"))
}

export async function importDeviceList(form: FormData) {
  return guard(async () => {
    const file = form.get("file")
    if (!(file instanceof File) || !file.size) throw new Error("Choose a CSV / XLSX file first")
    const mode = form.get("mode") === "replace" ? "replace" : "merge"
    const { fields, rows } = await readSheet(file)
    return importRows(fields, rows, String(form.get("listName") ?? ""), file.name, mode, String(form.get("defaultSite") ?? ""))
  })
}

export async function saveDevice(input: DeviceInput) {
  return guard(async () => ({ id: (await upsertDevice(input)).id }))
}

export async function removeDevice(id: string) {
  return guard(async () => { await deleteDevice(id); return true })
}

export async function removeList(list: string) {
  return guard(() => deleteList(list))
}
