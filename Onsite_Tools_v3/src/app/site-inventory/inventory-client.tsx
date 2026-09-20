"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Download, Pencil, Plus, Trash2, Upload } from "lucide-react"
import { AlertDialog } from "@astryxdesign/core/AlertDialog"
import { Badge } from "@astryxdesign/core/Badge"
import { Button } from "@astryxdesign/core/Button"
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog"
import { FormLayout } from "@astryxdesign/core/FormLayout"
import { IconButton } from "@astryxdesign/core/IconButton"
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout"
import { Selector } from "@astryxdesign/core/Selector"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useToast } from "@astryxdesign/core/Toast"
import { importDeviceList, removeDevice, removeList, saveDevice } from "@/actions/inventory"
import { Panel } from "@/components/page-header"

interface ListInfo { name: string; count: number; sites: string[]; filename: string; updated: string }
interface ImportInfo { id: string; list: string; filename: string; mode: string; rows: number; added: number; updated: number; skipped: number; removed: number; importedAt: string }
interface DeviceRow { id: string; list: string; site: string; ip: string; hostname: string; deviceType: string; model: string; brand: string; description: string; extra: string }
interface Summary { lists: ListInfo[]; sites: string[]; total: number; imports: ImportInfo[] }

const COLS: [keyof DeviceRow, string][] = [["list", "List"], ["site", "Site"], ["ip", "IP Address"], ["hostname", "Hostname"],
  ["deviceType", "Device Type"], ["model", "Model"], ["brand", "Brand"], ["description", "Description"]]
const TEMPLATES = ["device_list_template.csv", "device_list_command_template.csv", "upgrade_ios_template.csv"]
const PAGE = 100
const th = "bg-muted sticky top-0 border-b px-3 py-2 text-left font-semibold whitespace-nowrap"
const td = "max-w-[320px] truncate px-3 py-1.5 whitespace-nowrap"
const blank: DeviceRow = { id: "", list: "", site: "", ip: "", hostname: "", deviceType: "", model: "", brand: "", description: "", extra: "{}" }

export function InventoryClient({ summary, deviceTypes }: { summary: Summary; deviceTypes: string[] }) {
  const toast = useToast()
  const router = useRouter()
  const fileRef = React.useRef<HTMLInputElement>(null)
  const [listName, setListName] = React.useState("")
  const [defaultSite, setDefaultSite] = React.useState("")
  const [mode, setMode] = React.useState("merge")
  const [list, setList] = React.useState("All")
  const [site, setSite] = React.useState("All")
  const [q, setQ] = React.useState("")
  const [page, setPage] = React.useState(0)
  const [data, setData] = React.useState<{ total: number; devices: DeviceRow[] }>({ total: 0, devices: [] })
  const [reload, setReload] = React.useState(0)
  const [editing, setEditing] = React.useState<DeviceRow | null>(null)
  const [confirm, setConfirm] = React.useState<{ title: string; text: string; run: () => Promise<void> } | null>(null)

  const sites = list === "All" ? summary.sites : summary.lists.find((l) => l.name === list)?.sites ?? []

  React.useEffect(() => {
    let alive = true
    const t = setTimeout(() => {
      const qs = new URLSearchParams({ list, site, q, page: String(page), size: String(PAGE) })
      fetch(`/api/inventory/devices?${qs}`, { cache: "no-store" }).then((r) => r.json()).then((d) => { if (alive) setData(d) }).catch(() => undefined)
    }, q ? 250 : 0)
    return () => { alive = false; clearTimeout(t) }
  }, [list, site, q, page, reload])

  const refresh = () => { router.refresh(); setReload((n) => n + 1) }

  async function doImport() {
    const file = fileRef.current?.files?.[0]
    if (!file) { toast({ body: "Choose a CSV / XLSX file first", type: "error" }); return }
    const fd = new FormData()
    fd.append("file", file); fd.append("listName", listName); fd.append("mode", mode); fd.append("defaultSite", defaultSite)
    const r = await importDeviceList(fd)
    if (!r.ok) { toast({ body: `Import failed: ${r.error}`, type: "error" }); return }
    const d = r.data
    toast({ body: `Imported "${d.list}": ${d.added} added, ${d.updated} updated, ${d.skipped} skipped${d.removed ? `, ${d.removed} removed` : ""}` })
    if (fileRef.current) fileRef.current.value = ""
    setListName("")
    refresh()
  }

  async function saveEditing() {
    if (!editing) return
    const r = await saveDevice({ ...editing, id: editing.id || undefined })
    if (!r.ok) { toast({ body: r.error, type: "error" }); return }
    toast({ body: "Saved" })
    setEditing(null)
    refresh()
  }

  const pages = Math.max(1, Math.ceil(data.total / PAGE))

  return (
    <>
      <Panel title="Import device list">
        <div className="grid grid-cols-1 gap-x-5 gap-y-4 md:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium">File (CSV / XLSX)</label>
            <input ref={fileRef} type="file" accept=".csv,.xlsx"
              onChange={(e) => { const f = e.target.files?.[0]; if (f && !listName) setListName(f.name.replace(/\.[^.]+$/, "")) }}
              className="border-input bg-background file:bg-secondary file:text-secondary-foreground block w-full rounded-lg border p-1.5 text-sm file:mr-3 file:rounded-md file:border-0 file:px-3 file:py-1" />
            <p className="text-muted-foreground mt-1 text-xs">Needs an IP column (IP_Address / ip_mgmt / ip / managementIpAddress). Optional: Site or zone, Hostname, Device_Type, Model, Brand, Description. Other columns (e.g. command) are kept too.</p>
          </div>
          <TextInput label="List name" value={listName} onChange={setListName} placeholder="Default: file name" description="Tools select devices by list and site." />
          <Selector label="Import mode" value={mode} onChange={setMode}
            options={[{ value: "merge", label: "Merge – add new devices, update existing IPs" }, { value: "replace", label: "Replace – list will contain exactly this file" }]} />
          <TextInput label="Default site" value={defaultSite} onChange={setDefaultSite} isOptional placeholder="Used when the file has no Site column" />
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button variant="primary" label="Import" icon={<Upload className="h-3.5 w-3.5" />}
            clickAction={async () => {
              if (mode === "replace") setConfirm({ title: "Replace list", text: `All devices currently in list "${listName || "(file name)"}" will be replaced by this file.`, run: doImport })
              else await doImport()
            }} />
          <span className="text-muted-foreground text-xs">Templates:</span>
          {TEMPLATES.map((t) => <a key={t} className="text-primary inline-flex items-center gap-1 text-xs underline" href={`/api/templates/${t}`}><Download className="h-3 w-3" />{t}</a>)}
        </div>
      </Panel>

      <Panel title="Device lists" actions={<span className="text-muted-foreground text-xs">{summary.total.toLocaleString()} device(s) in {summary.lists.length} list(s), {summary.sites.length} site(s)</span>}>
        {summary.lists.length === 0 ? <p className="text-muted-foreground text-sm">No lists yet – import a file above.</p> : (
          <div className="max-h-[30vh] overflow-auto rounded-xl border">
            <table className="w-full border-collapse text-[13px]">
              <thead><tr>{["List", "Devices", "Sites", "Last import file", "Updated", ""].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
              <tbody>
                {summary.lists.map((l) => (
                  <tr key={l.name} className="hover:bg-muted/50 border-b last:border-0">
                    <td className={`${td} font-semibold`}>{l.name}</td>
                    <td className={td}>{l.count.toLocaleString()}</td>
                    <td className={td} title={l.sites.join(", ")}>{l.sites.length} – {l.sites.slice(0, 6).join(", ")}{l.sites.length > 6 ? "…" : ""}</td>
                    <td className={td}>{l.filename}</td>
                    <td className={td}>{l.updated ? new Date(l.updated).toLocaleString("sv-SE") : ""}</td>
                    <td className={`${td} text-right`}>
                      <Button variant="ghost" size="sm" label="View" onClick={() => { setList(l.name); setSite("All"); setPage(0) }} />
                      <Button variant="ghost" size="sm" label="Export" href={`/api/inventory/export?list=${encodeURIComponent(l.name)}`} />
                      <Button variant="ghost" size="sm" label="Delete"
                        onClick={() => setConfirm({ title: "Delete list", text: `Delete list "${l.name}" and its ${l.count} device(s) from Site Inventory?`,
                          run: async () => { const r = await removeList(l.name); toast(r.ok ? { body: `Removed ${r.data} device(s)` } : { body: r.error, type: "error" }); if (list === l.name) setList("All"); refresh() } })} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Devices" actions={
        <>
          <Button variant="secondary" size="sm" label="Add device" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEditing({ ...blank, list: list === "All" ? "" : list })} />
          <Button variant="secondary" size="sm" label="Export CSV" icon={<Download className="h-3.5 w-3.5" />} href={`/api/inventory/export?list=${encodeURIComponent(list)}&site=${encodeURIComponent(site)}`} />
        </>
      }>
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <div className="w-64"><Selector label="List" size="sm" value={list} onChange={(v) => { setList(v); setSite("All"); setPage(0) }} hasSearch={summary.lists.length > 10}
            options={[{ value: "All", label: "All lists" }, ...summary.lists.map((l) => ({ value: l.name, label: `${l.name} (${l.count})` }))]} /></div>
          <div className="w-48"><Selector label="Site" size="sm" value={site} onChange={(v) => { setSite(v); setPage(0) }} hasSearch={sites.length > 10}
            options={[{ value: "All", label: "All sites" }, ...sites.map((s) => ({ value: s, label: s }))]} /></div>
          <div className="w-72"><TextInput label="Search" size="sm" value={q} onChange={(v) => { setQ(v); setPage(0) }} hasClear placeholder="IP, hostname, description…" /></div>
          <span className="text-muted-foreground pb-2 text-xs">{data.total.toLocaleString()} device(s)</span>
          {pages > 1 && (
            <span className="flex items-center gap-1 pb-1 text-xs">
              <Button variant="ghost" size="sm" label="Prev" isDisabled={page === 0} onClick={() => setPage(page - 1)} />
              page {page + 1}/{pages}
              <Button variant="ghost" size="sm" label="Next" isDisabled={page >= pages - 1} onClick={() => setPage(page + 1)} />
            </span>
          )}
        </div>
        {data.devices.length === 0 ? <p className="text-muted-foreground text-sm">No devices match.</p> : (
          <div className="max-h-[55vh] overflow-auto rounded-xl border">
            <table className="w-full border-collapse text-[13px]">
              <thead><tr>{COLS.map(([, h]) => <th key={h} className={th}>{h}</th>)}<th className={th}>Extra</th><th className={th} /></tr></thead>
              <tbody>
                {data.devices.map((d) => {
                  const extra = Object.keys(safeJson(d.extra))
                  return (
                    <tr key={d.id} className="hover:bg-muted/50 border-b last:border-0">
                      {COLS.map(([k]) => <td key={k} className={td} title={d[k]}>{d[k]}</td>)}
                      <td className={td}>{extra.map((k) => <Badge key={k} variant="neutral" label={k} />)}</td>
                      <td className={`${td} text-right`}>
                        <IconButton variant="ghost" size="sm" label="Edit" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEditing(d)} />
                        <IconButton variant="ghost" size="sm" label="Delete" icon={<Trash2 className="h-3.5 w-3.5" />}
                          onClick={() => setConfirm({ title: "Delete device", text: `Remove ${d.ip} (${d.hostname || d.description || d.site}) from list "${d.list}"?`,
                            run: async () => { const r = await removeDevice(d.id); if (!r.ok) toast({ body: r.error, type: "error" }); refresh() } })} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Import history">
        {summary.imports.length === 0 ? <p className="text-muted-foreground text-sm">Nothing imported yet.</p> : (
          <div className="max-h-[30vh] overflow-auto rounded-xl border">
            <table className="w-full border-collapse text-[13px]">
              <thead><tr>{["When", "List", "File", "Mode", "Rows", "Added", "Updated", "Skipped", "Removed"].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
              <tbody>
                {summary.imports.map((i) => (
                  <tr key={i.id} className="border-b last:border-0">
                    {[i.importedAt, i.list, i.filename, i.mode, i.rows, i.added, i.updated, i.skipped, i.removed].map((v, n) => <td key={n} className={td}>{v}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {editing && (
        <Dialog isOpen onOpenChange={(open) => { if (!open) setEditing(null) }} purpose="form" width={560}>
          <Layout
            header={<DialogHeader title={editing.id ? `Edit ${editing.ip}` : "Add device"} onOpenChange={() => setEditing(null)} />}
            content={
              <LayoutContent>
                <FormLayout>
                  <TextInput label="List" value={editing.list} onChange={(v) => setEditing({ ...editing, list: v })} placeholder="manual" />
                  <TextInput label="Site" value={editing.site} onChange={(v) => setEditing({ ...editing, site: v })} isOptional />
                  <TextInput label="IP Address" value={editing.ip} onChange={(v) => setEditing({ ...editing, ip: v })} isRequired />
                  <TextInput label="Hostname" value={editing.hostname} onChange={(v) => setEditing({ ...editing, hostname: v })} isOptional />
                  <Selector label="Device Type" value={editing.deviceType} onChange={(v) => setEditing({ ...editing, deviceType: v })}
                    options={[{ value: "", label: "(use the tool's setting)" }, ...deviceTypes.map((t) => ({ value: t, label: t }))]} />
                  <TextInput label="Model" value={editing.model} onChange={(v) => setEditing({ ...editing, model: v })} isOptional />
                  <TextInput label="Brand" value={editing.brand} onChange={(v) => setEditing({ ...editing, brand: v })} isOptional />
                  <TextInput label="Description" value={editing.description} onChange={(v) => setEditing({ ...editing, description: v })} isOptional />
                </FormLayout>
              </LayoutContent>
            }
            footer={
              <LayoutFooter hasDivider>
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" label="Cancel" onClick={() => setEditing(null)} />
                  <Button variant="primary" label="Save" isDisabled={!editing.ip.trim()} clickAction={saveEditing} />
                </div>
              </LayoutFooter>
            }
          />
        </Dialog>
      )}

      {confirm && (
        <AlertDialog isOpen onOpenChange={(open) => { if (!open) setConfirm(null) }} title={confirm.title} description={confirm.text}
          cancelLabel="Cancel" actionLabel="Confirm" actionVariant="destructive"
          onAction={async () => { const c = confirm; setConfirm(null); await c.run() }} />
      )}
    </>
  )
}

function safeJson(text: string): Record<string, string> {
  try { return JSON.parse(text) } catch { return {} }
}
