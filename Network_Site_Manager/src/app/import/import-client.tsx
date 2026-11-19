"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { FileUp, Share2, Trash2, Upload, X } from "lucide-react"
import { Badge } from "@astryxdesign/core/Badge"
import { Button } from "@astryxdesign/core/Button"
import { Selector } from "@astryxdesign/core/Selector"
import { TextArea } from "@astryxdesign/core/TextArea"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useToast } from "@astryxdesign/core/Toast"
import { DataTable, Td } from "@/components/data-table"
import { Panel } from "@/components/page-header"
import { parseConfig, type ParsedConfig } from "@/lib/config-parser"
import { importConfigs, removeConfig } from "./actions"

interface Row { key: string; fileName: string; raw: string; cfg: ParsedConfig; hostname: string }
interface StoredRow { hostname: string; fileName: string; importedAt: string; size: number }

const MAX_FILE = 2 * 1024 * 1024
const PLATFORM: Record<string, string> = { ios: "Cisco IOS / IOS-XE", nxos: "Cisco NX-OS", "aos-cx": "Aruba AOS-CX", unknown: "Unknown" }

export function ImportClient({ sites, siteCode, stored, deviceHostnames }: {
  sites: { code: string; name: string }[]
  siteCode: string
  stored: StoredRow[]
  deviceHostnames: string[]
}) {
  const router = useRouter()
  const toast = useToast()
  const [rows, setRows] = React.useState<Row[]>([])
  const [paste, setPaste] = React.useState("")
  const [dragging, setDragging] = React.useState(false)
  const fileRef = React.useRef<HTMLInputElement>(null)
  const storedNames = new Set(stored.map((s) => s.hostname.toLowerCase()))
  const deviceNames = new Set(deviceHostnames.map((h) => h.toLowerCase()))

  const addTexts = (items: { fileName: string; raw: string }[]) => {
    setRows((prev) => [
      ...prev,
      ...items.map((it, n) => {
        const cfg = parseConfig(it.raw)
        return { key: `${Date.now()}-${n}-${it.fileName}`, fileName: it.fileName, raw: it.raw, cfg, hostname: cfg.hostname ?? "" }
      }),
    ])
  }

  const addFiles = async (files: FileList | File[]) => {
    const list = [...files]
    const tooBig = list.filter((f) => f.size > MAX_FILE)
    if (tooBig.length) toast({ body: `ข้ามไฟล์ที่ใหญ่เกิน 2 MB: ${tooBig.map((f) => f.name).join(", ")}`, type: "error" })
    addTexts(await Promise.all(list.filter((f) => f.size <= MAX_FILE).map(async (f) => ({ fileName: f.name, raw: await f.text() }))))
    if (fileRef.current) fileRef.current.value = ""
  }

  const status = (r: Row): { label: string; variant: "green" | "yellow" | "red" | "neutral" } => {
    if (!r.hostname.trim()) return { label: "ไม่พบ hostname", variant: "red" }
    if (r.cfg.interfaces.length === 0) return { label: "ไม่พบ interface", variant: "red" }
    const h = r.hostname.trim().toLowerCase()
    if (storedNames.has(h)) return { label: "แทนที่ config เดิม", variant: "yellow" }
    if (deviceNames.has(h)) return { label: "อัปเดตอุปกรณ์เดิม", variant: "green" }
    return { label: "อุปกรณ์ใหม่", variant: "neutral" }
  }
  const valid = rows.filter((r) => status(r).variant !== "red")

  const doImport = async () => {
    const res = await importConfigs({ siteCode, items: valid.map((r) => ({ fileName: r.fileName, raw: r.raw, hostname: r.hostname.trim() })) })
    if (!res.ok) { toast({ body: res.error ?? "Import ไม่สำเร็จ", type: "error" }); return }
    const skipped = res.skipped.length ? ` · ข้าม ${res.skipped.length} ไฟล์: ${res.skipped.map((s) => `${s.fileName} (${s.reason})`).join(", ")}` : ""
    toast({ body: `Import สำเร็จ ${res.saved.length} อุปกรณ์${skipped}`, type: res.skipped.length ? "error" : undefined })
    setRows([])
    router.refresh()
  }

  return (
    <>
      <Panel>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-72">
            <Selector label="Site" value={siteCode} onChange={(v) => router.push(`/import?site=${encodeURIComponent(v)}`)}
              options={sites.map((s) => ({ value: s.code, label: `${s.code} · ${s.name}` }))} />
          </div>
          <Button variant="secondary" label="Open diagram" icon={<Share2 className="h-3.5 w-3.5" />} href={`/diagram?site=${encodeURIComponent(siteCode)}`} />
        </div>
      </Panel>

      <Panel title="1. เลือกไฟล์ config">
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); void addFiles(e.dataTransfer.files) }}
          className={`flex flex-col items-center justify-center gap-2 rounded-[var(--corner-control)] border-2 border-dashed p-8 text-center ${dragging ? "border-primary bg-muted" : "border-border"}`}
        >
          <FileUp className="text-muted-foreground size-8" />
          <div className="text-sm">ลากไฟล์มาวางที่นี่ หรือ</div>
          <Button variant="secondary" size="sm" label="Browse files" onClick={() => fileRef.current?.click()} />
          <div className="text-muted-foreground text-xs">.txt .cfg .conf .log · ไฟล์ละไม่เกิน 2 MB · เลือกได้หลายไฟล์ (1 ไฟล์ต่อ 1 อุปกรณ์)</div>
          <input ref={fileRef} type="file" multiple accept=".txt,.cfg,.conf,.log,.config,text/plain" className="hidden"
            onChange={(e) => e.target.files && void addFiles(e.target.files)} />
        </div>
        <details className="mt-3">
          <summary className="text-muted-foreground cursor-pointer text-sm">หรือวาง config เป็นข้อความ</summary>
          <div className="mt-2">
            <TextArea label="Running-config" value={paste} onChange={setPaste} rows={8} placeholder={"hostname SW-01\n!\ninterface GigabitEthernet1/0/1\n description TO CORE-01 Gi1/0/10\n..."} />
            <div className="mt-2">
              <Button variant="secondary" size="sm" label="Add pasted config" isDisabled={!paste.trim()}
                onClick={() => { addTexts([{ fileName: `pasted-${rows.length + 1}.txt`, raw: paste }]); setPaste("") }} />
            </div>
          </div>
        </details>
      </Panel>

      <Panel title={`2. ตรวจสอบก่อน Import (${rows.length})`}
        actions={rows.length > 0 && <Button variant="ghost" size="sm" label="Clear all" onClick={() => setRows([])} />}>
        {rows.length === 0 ? <p className="text-muted-foreground text-sm">ยังไม่ได้เลือกไฟล์</p> : (
          <>
            <DataTable head={["File", "Hostname", "Platform", "Version", "Interfaces", "IP addresses", "VLANs", "Mgmt IP", "Result", ""]}>
              {rows.map((r) => {
                const st = status(r)
                return (
                  <tr key={r.key}>
                    <Td mono>{r.fileName}</Td>
                    <Td>
                      {r.cfg.hostname ? <span className="font-medium">{r.hostname}</span> : (
                        <div className="w-40"><TextInput label="Hostname" isLabelHidden size="sm" value={r.hostname} placeholder="ระบุ hostname"
                          onChange={(v) => setRows((prev) => prev.map((x) => (x.key === r.key ? { ...x, hostname: v } : x)))} /></div>
                      )}
                    </Td>
                    <Td>{PLATFORM[r.cfg.platform]}</Td>
                    <Td mono>{r.cfg.version ?? "—"}</Td>
                    <Td>{r.cfg.interfaces.length}</Td>
                    <Td>{r.cfg.interfaces.filter((i) => i.ip).length}</Td>
                    <Td>{r.cfg.vlans.length}</Td>
                    <Td mono>{r.cfg.mgmtIp ?? "—"}</Td>
                    <Td><Badge variant={st.variant} label={st.label} /></Td>
                    <Td>
                      <button type="button" aria-label={`Remove ${r.fileName}`} className="text-muted-foreground hover:text-foreground"
                        onClick={() => setRows((prev) => prev.filter((x) => x.key !== r.key))}><X className="size-4" /></button>
                    </Td>
                  </tr>
                )
              })}
            </DataTable>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button variant="primary" label={`Import ${valid.length} config เข้า ${siteCode}`} icon={<Upload className="h-3.5 w-3.5" />}
                isDisabled={valid.length === 0} clickAction={doImport} />
              {valid.length < rows.length && <span className="text-destructive text-xs">{rows.length - valid.length} ไฟล์จะถูกข้าม (ดูคอลัมน์ Result)</span>}
            </div>
          </>
        )}
      </Panel>

      <Panel title={`Config ที่ Import แล้วของ ${siteCode} (${stored.length})`}>
        {stored.length === 0 ? <p className="text-muted-foreground text-sm">ยังไม่มี config ของ Site นี้</p> : (
          <DataTable head={["Hostname", "File", "Imported at", "Size", ""]}>
            {stored.map((s) => (
              <tr key={s.hostname}>
                <Td><span className="font-medium">{s.hostname}</span></Td>
                <Td mono>{s.fileName}</Td>
                <Td>{new Date(s.importedAt).toLocaleString("sv-SE", { timeZone: "Asia/Bangkok" }).slice(0, 16)}</Td>
                <Td>{(s.size / 1024).toFixed(1)} KB</Td>
                <Td>
                  <Button variant="ghost" size="sm" label="Delete" icon={<Trash2 className="h-3.5 w-3.5" />}
                    clickAction={async () => {
                      if (!window.confirm(`ลบ config ของ ${s.hostname}? ข้อมูลที่ได้จาก config นี้จะหายไปจาก Site และ Diagram`)) return
                      const r = await removeConfig(siteCode, s.hostname)
                      toast(r.ok ? { body: `ลบ config ของ ${s.hostname} แล้ว` } : { body: "ลบไม่สำเร็จ", type: "error" })
                      router.refresh()
                    }} />
                </Td>
              </tr>
            ))}
          </DataTable>
        )}
        <p className="text-muted-foreground mt-3 text-xs">
          Import ซ้ำด้วย hostname เดิมจะแทนที่ config เดิม · ดูผลได้ที่ <Link className="text-primary underline" href={`/sites/${siteCode}`}>หน้า Site</Link> และ <Link className="text-primary underline" href={`/diagram?site=${siteCode}`}>Diagram</Link>
        </p>
      </Panel>
    </>
  )
}
