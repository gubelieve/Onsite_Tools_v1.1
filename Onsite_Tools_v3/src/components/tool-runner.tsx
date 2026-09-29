"use client"

import * as React from "react"
import { CheckCircle2, Download, FolderOpen, Play } from "lucide-react"
import { AlertDialog } from "@astryxdesign/core/AlertDialog"
import { Badge } from "@astryxdesign/core/Badge"
import { Button } from "@astryxdesign/core/Button"
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput"
import { NumberInput } from "@astryxdesign/core/NumberInput"
import { MultiSelector } from "@astryxdesign/core/MultiSelector"
import { Selector } from "@astryxdesign/core/Selector"
import { TextArea } from "@astryxdesign/core/TextArea"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useToast } from "@astryxdesign/core/Toast"
import { DevicePreview, type PreviewDevice } from "@/components/device-preview"
import { JobPanel } from "@/components/job-panel"
import { Panel } from "@/components/page-header"
import { ANY_CATEGORY, type FieldDef, type PublicTool, type RunDef } from "@/lib/tools/types"

type Values = Record<string, unknown>
interface HistoryItem { id: string; runLabel: string; status: string; created: string; rowCount: number }
interface SessionInfo { active: boolean; dir: string; name: string; started: string; rowCount: number; runs: string[] }
interface Options { lists: string[]; sites: string[]; count: number; devices: PreviewDevice[] }
interface Defaults { username: string; deviceType: string; threads: number; snmpCommunity: string; localIp: string }

const CRED_KEY = "onsite:creds"
const load = <T,>(key: string, fallback: T): T => { try { return JSON.parse(localStorage.getItem(key) ?? "") as T } catch { return fallback } }

export function ToolRunner({ tool, deviceTypes, defaults }: { tool: PublicTool; deviceTypes: string[]; defaults: Defaults }) {
  const toast = useToast()
  const [values, setValues] = React.useState<Values>(() => Object.fromEntries(tool.fields.map((f) => [
    f.name, f.defaultFrom && defaults[f.defaultFrom] ? defaults[f.defaultFrom] : f.default ?? (f.type === "checkbox" ? false : f.type === "files" ? [] : "")])))
  const [remember, setRemember] = React.useState(false)
  const [inv, setInv] = React.useState<Options | null>(null)
  const [fileInfo, setFileInfo] = React.useState<Record<string, string>>({})
  const [jobId, setJobId] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [history, setHistory] = React.useState<HistoryItem[]>([])
  const [pending, setPending] = React.useState<RunDef | null>(null)
  const usesInventory = tool.fields.some((f) => f.source)
  const showDevices = tool.fields.some((f) => f.showCount)
  const set = (name: string, v: unknown) => setValues((p) => ({ ...p, [name]: v }))

  // Restore what this browser remembered (never sent anywhere else).
  // localStorage only exists in the browser, so this runs after hydration (the server render uses the defaults).
  React.useEffect(() => {
    const timer = setTimeout(() => {
      const saved = load<Values>(`onsite:form:${tool.id}`, {})
      const rememberCreds = load<boolean>("onsite:remember", false)
      const creds = rememberCreds ? load<Values>(CRED_KEY, {}) : {}
      setRemember(rememberCreds)
      setValues((p) => {
        const next = { ...p }
        for (const f of tool.fields) {
          if (["file", "files"].includes(f.type)) continue
          const v = f.type === "password" || f.remember ? creds[f.name] : saved[f.name]
          if (v !== undefined && v !== "") next[f.name] = v
        }
        return next
      })
    }, 0)
    return () => clearTimeout(timer)
  }, [tool])

  const [historyTick, setHistoryTick] = React.useState(0)
  const refreshHistory = React.useCallback(() => setHistoryTick((n) => n + 1), [])
  React.useEffect(() => {
    let alive = true
    fetch(`/api/jobs?tool=${tool.id}`, { cache: "no-store" }).then((x) => x.json())
      .then((r) => { if (alive) setHistory([...r.running.map((j: HistoryItem) => ({ ...j, rowCount: j.rowCount ?? 0 })), ...r.history]) })
      .catch(() => undefined)
    return () => { alive = false }
  }, [tool.id, historyTick])

  // Session tools (IOS Upgrade) keep every run in one folder until Done, so the bar has to follow every run.
  const [session, setSession] = React.useState<SessionInfo | null>(null)
  React.useEffect(() => {
    if (!tool.session) return
    let alive = true
    fetch(`/api/sessions/${tool.id}`, { cache: "no-store" }).then((r) => r.json())
      .then((d: SessionInfo) => { if (alive) setSession(d) }).catch(() => undefined)
    return () => { alive = false }
  }, [tool.session, tool.id, historyTick])

  // null = every device of the list/category selection; a set = only the devices ticked in the form.
  const [picked, setPicked] = React.useState<Set<string> | null>(null)

  // Both pickers take several values; nothing picked means every list / every category.
  const chosen = (name: string): string[] => {
    const v = values[name]
    return Array.isArray(v) ? v.map(String).filter((x) => x && x !== "All") : v && v !== "All" ? [String(v)] : []
  }
  const list = chosen("inventoryList"), site = chosen("site")
  const query = [...list.map((l) => `list=${encodeURIComponent(l)}`), ...site.map((s) => `site=${encodeURIComponent(s)}`)].join("&")
  React.useEffect(() => {
    if (!usesInventory) return
    let alive = true
    fetch(`/api/inventory/options?${query}`, { cache: "no-store" })
      .then((r) => r.json()).then((d: Options) => {
        if (!alive) return
        setInv(d)
        setPicked(null) // a different list or category is a different set of devices - start from all of them
        // A list or category that no longer exists (a re-import) drops out instead of returning nothing.
        const keepLists = list.filter((l) => d.lists.includes(l))
        const keepSites = site.filter((s) => d.sites.includes(s))
        if (keepLists.length !== list.length) set("inventoryList", keepLists)
        if (keepSites.length !== site.length) set("site", keepSites)
      }).catch(() => undefined)
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usesInventory, query])

  const visible = (f: FieldDef) => !f.showIf || Object.entries(f.showIf).every(([k, v]) => String(values[k] ?? "") === v)

  /** How many devices this run would touch - shown in a confirmation so nobody guesses. */
  const deviceCount = picked ? picked.size : inv?.count ?? 0
  /** Some runs only make sense in one mode - a manual install step has no place when the form says one-shot. */
  const matches = (cond?: Record<string, string>) => Boolean(cond) && Object.entries(cond!).every(([k, v]) => String(values[k] ?? "") === v)
  const runVisible = (r: RunDef) => (!r.showIf || matches(r.showIf)) && !(r.hideIf && matches(r.hideIf))

  /** A run asks first when it always asks (confirm / notice) or when the form is in the state it asks about. */
  const needsAsking = (r: RunDef) =>
    Boolean(r.notice) || (Boolean(r.confirm) && (!r.confirmIf || Object.entries(r.confirmIf).every(([k, v]) => String(values[k] ?? "") === v)))

  async function upload(f: FieldDef, files: FileList | null) {
    if (!files?.length) return
    const fd = new FormData()
    for (const file of files) fd.append("files", file)
    setFileInfo((p) => ({ ...p, [f.name]: "Uploading…" }))
    const r = await fetch("/api/upload", { method: "POST", body: fd })
    const data = await r.json()
    if (!r.ok) { setFileInfo((p) => ({ ...p, [f.name]: `Upload failed: ${data.error}` })); return }
    set(f.name, f.type === "files" ? data : data[0])
    setFileInfo((p) => ({ ...p, [f.name]: f.type === "files" ? `${data.length} file(s) uploaded` : `${data[0].name} (${data[0].size.toLocaleString()} bytes)` }))
  }

  async function start(run: RunDef) {
    setPending(null)
    if (showDevices && picked && picked.size === 0) {
      toast({ body: "No device is ticked in the device list.", type: "error" })
      return
    }
    const params: Values = {}
    for (const f of tool.fields) if (visible(f)) params[f.name] = values[f.name]
    // Only sent when the user narrowed the selection by hand; otherwise the run uses the whole list/category.
    if (picked) params.deviceIps = [...picked]
    const plain: Values = {}, creds: Values = load<Values>(CRED_KEY, {})
    for (const f of tool.fields) {
      if (["file", "files"].includes(f.type)) continue
      if (f.type === "password" || f.remember) { if (remember) creds[f.name] = values[f.name] } else plain[f.name] = values[f.name]
    }
    localStorage.setItem(`onsite:form:${tool.id}`, JSON.stringify(plain))
    localStorage.setItem("onsite:remember", JSON.stringify(remember))
    if (remember) localStorage.setItem(CRED_KEY, JSON.stringify(creds)); else localStorage.removeItem(CRED_KEY)
    setBusy(true)
    try {
      const r = await fetch(`/api/tools/${tool.id}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ params, runId: run.id }) })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error)
      setJobId(data.jobId)
      refreshHistory()
    } catch (e) {
      setBusy(false)
      toast({ body: (e as Error).message, type: "error" })
    }
  }

  function field(f: FieldDef) {
    const v = values[f.name]
    const common = { label: f.label, description: f.help, isRequired: f.required }
    switch (f.type) {
      case "path":
        return (
          <div>
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <TextInput label={f.label} isRequired={f.required} value={String(v ?? "")} placeholder={f.placeholder} onChange={(x) => set(f.name, x)} />
            </div>
            <Button variant="secondary" label={f.kind === "folder" ? "Browse folder" : "Browse file"} icon={<FolderOpen className="h-3.5 w-3.5" />}
              clickAction={async () => {
                const r = await fetch("/api/browse", { method: "POST", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ kind: f.kind ?? "file", title: f.browseTitle ?? f.label, filter: f.browseFilter,
                    initial: String(v ?? "") }) }) // reopen where the last pick came from
                const data = await r.json()
                if (!r.ok) toast({ body: data.error, type: "error" })
                else if (data.path) set(f.name, data.path)
              }} />
          </div>
          {f.help && <p className="text-muted-foreground mt-1 text-xs">{f.help}</p>}
          </div>
        )
      case "text": case "password":
        return <TextInput {...common} type={f.type === "password" ? "password" : "text"} value={String(v ?? "")} placeholder={f.placeholder} onChange={(x) => set(f.name, x)} />
      case "number":
        return <NumberInput {...common} value={Number(v) || 0} min={f.min} max={f.max} onChange={(x) => set(f.name, Number(x) || 0)} />
      case "textarea":
        return <TextArea {...common} value={String(v ?? "")} rows={f.rows ?? 4} placeholder={f.placeholder} onChange={(x) => set(f.name, x)} hasSpellCheck={false} />
      case "commandsPerCategory": {
        // One box for everything, plus a box per Device Category for the ones that need different commands
        // (a WLC and an access switch are not worth asking the same questions).
        const byCategory: Record<string, string> = v && typeof v === "object" ? { ...(v as Record<string, string>) } : { [ANY_CATEGORY]: String(v ?? "") }
        const setOne = (key: string, text: string) => set(f.name, { ...byCategory, [key]: text })
        const categories = (inv?.sites ?? []).filter((c) => c && c !== "All")
        const own = categories.filter((c) => (byCategory[c] ?? "").trim())
        return (
          <div>
            <TextArea label={f.label} value={byCategory[ANY_CATEGORY] ?? ""} rows={f.rows ?? 4} hasSpellCheck={false}
              description="Used by every Device Category that has no list of its own." onChange={(x) => setOne(ANY_CATEGORY, x)} />
            {categories.length > 0 && (
              <details className="mt-2 rounded-lg border px-3 py-2" open={own.length > 0}>
                <summary className="cursor-pointer text-sm font-medium">
                  Per Device Category{own.length ? ` — ${own.length} of ${categories.length} have their own list` : ` (${categories.length})`}
                </summary>
                <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2">
                  {categories.map((c) => (
                    <TextArea key={c} label={c} value={byCategory[c] ?? ""} rows={3} hasSpellCheck={false}
                      placeholder="empty = use the list above" onChange={(x) => setOne(c, x)} />
                  ))}
                </div>
              </details>
            )}
            {f.help && <p className="text-muted-foreground mt-1 text-xs">{f.help}</p>}
          </div>
        )
      }
      case "checkbox":
        return <CheckboxInput {...common} value={Boolean(v)} onChange={(x) => set(f.name, x)} />
      case "select": {
        const all = [{ value: "All", label: "All" }]
        const options = f.source?.type === "inventoryLists" ? [...all, ...(inv?.lists ?? []).map((x) => ({ value: x, label: x }))]
          : f.source?.type === "inventorySites" ? [...all, ...(inv?.sites ?? []).map((x) => ({ value: x, label: x }))]
          : f.options === "deviceTypes" ? deviceTypes.map((x) => ({ value: x, label: x })) : f.options ?? []
        // The device count and the devices themselves are shown once, under the whole form (DevicePreview).
        return <Selector {...common} options={options} value={String(v ?? "")} onChange={(x) => set(f.name, x)} hasSearch={options.length > 12} />
      }
      case "multiSelect": {
        const options = (f.source?.type === "inventoryLists" ? inv?.lists : f.source?.type === "inventorySites" ? inv?.sites : [])
          ?.map((x) => ({ value: x, label: x })) ?? []
        const value = Array.isArray(v) ? v.map(String).filter((x) => x && x !== "All") : v && v !== "All" ? [String(v)] : []
        // Nothing picked = everything, which is what the placeholder says and what the server does with an empty list.
        return (
          <MultiSelector label={f.label} description={f.help} isRequired={f.required} options={options} value={value}
            onChange={(x) => set(f.name, x)} placeholder={f.placeholder ?? "All"} hasSearch={options.length > 8}
            hasSelectAll hasClear triggerDisplay="badges" maxBadges={4} />
        )
      }
      case "file": case "files":
        return (
          <div>
            <label className="mb-1 block text-sm font-medium">{f.label}{f.required && <span className="text-destructive"> *</span>}
              {f.template && <a className="text-primary ml-2 inline-flex items-center gap-1 text-xs font-normal underline" href={`/api/templates/${f.template}`}><Download className="h-3 w-3" />Template</a>}
            </label>
            <input type="file" accept={f.accept} multiple={f.type === "files"} onChange={(e) => void upload(f, e.target.files)}
              className="border-input bg-background file:bg-secondary file:text-secondary-foreground block w-full rounded-lg border p-1.5 text-sm file:mr-3 file:rounded-md file:border-0 file:px-3 file:py-1" />
            <p className="text-muted-foreground mt-1 text-xs">{fileInfo[f.name] ?? f.help}</p>
          </div>
        )
    }
  }

  return (
    <>
      {tool.session && session && (
        <Panel>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
            <Badge variant={session.active ? "info" : "neutral"} label={session.active ? "SESSION OPEN" : "NO SESSION"} />
            {session.active ? (
              <>
                <span><b>{session.name}</b> · started {session.started}</span>
                <span className="text-muted-foreground">{session.runs.length ? session.runs.join(" → ") : "no stage run yet"} · {session.rowCount} row(s)</span>
                <span className="text-muted-foreground inline-flex items-center gap-1 text-xs" title={session.dir}><FolderOpen className="h-3.5 w-3.5" />{session.dir}</span>
                <span className="flex-1" />
                <Button variant="secondary" size="sm" label="Done — start a new session" icon={<CheckCircle2 className="h-3.5 w-3.5" />}
                  clickAction={async () => {
                    await fetch(`/api/sessions/${tool.id}`, { method: "DELETE" })
                    toast({ body: "Session closed. The next run starts a new log folder." })
                    refreshHistory()
                  }} />
              </>
            ) : (
              <span className="text-muted-foreground">The next run opens a new log folder. Every stage after it joins the same folder and the same table until you press Done.</span>
            )}
          </div>
        </Panel>
      )}

      <Panel>
        <div className="grid grid-cols-1 gap-x-5 gap-y-4 md:grid-cols-2">
          {tool.fields.filter(visible).map((f) => (
            <div key={f.name} className={f.width === "half" ? "" : "md:col-span-2"}>{field(f)}</div>
          ))}
          {showDevices && (
            <div className="md:col-span-2">
              {inv ? <DevicePreview devices={inv.devices} count={inv.count} selected={picked} onSelect={setPicked} />
                : <p className="text-muted-foreground text-sm">Loading devices…</p>}
            </div>
          )}
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          {tool.runs.filter(runVisible).map((r) => (
            <Button key={r.id} label={r.label} variant={r.danger ? "destructive" : "primary"} isDisabled={busy} icon={<Play className="h-3.5 w-3.5" />}
              onClick={() => (needsAsking(r) ? setPending(r) : void start(r))} />
          ))}
          <span className="flex-1" />
          {tool.fields.some((f) => f.type === "password") && <CheckboxInput label="Remember credentials in this browser" value={remember} onChange={setRemember} size="sm" />}
          {history.length > 0 && (
            <div className="w-80">
              <Selector label="Previous runs" isLabelHidden placeholder="Previous runs…" size="sm" value={jobId ?? ""}
                options={history.map((h) => ({ value: h.id, label: `${h.created} · ${h.runLabel} · ${h.status} · ${h.rowCount} rows` }))}
                onChange={(id) => { setBusy(false); setJobId(id) }} />
            </div>
          )}
        </div>
      </Panel>

      {jobId && <Panel title="Results"><JobPanel key={jobId} jobId={jobId} onFinished={() => { setBusy(false); refreshHistory() }} /></Panel>}

      {pending && (
        <AlertDialog isOpen onOpenChange={(open) => { if (!open) setPending(null) }} title={pending.label}
          description={(pending.confirm ?? pending.notice ?? "").replace("{count}", deviceCount.toLocaleString())}
          cancelLabel="Cancel" actionLabel={pending.confirm ? "Confirm" : "Continue"} actionVariant={pending.danger ? "destructive" : "primary"}
          onAction={() => void start(pending)} />
      )}
    </>
  )
}
