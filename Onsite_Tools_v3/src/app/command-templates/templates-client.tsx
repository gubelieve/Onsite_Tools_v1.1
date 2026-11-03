"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Copy, Plus, Save, Trash2 } from "lucide-react"
import { AlertDialog } from "@astryxdesign/core/AlertDialog"
import { Badge } from "@astryxdesign/core/Badge"
import { Button } from "@astryxdesign/core/Button"
import { TextArea } from "@astryxdesign/core/TextArea"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useToast } from "@astryxdesign/core/Toast"
import { removeCommandTemplate, saveCommandTemplate } from "@/actions/command-templates"
import { Panel } from "@/components/page-header"
import type { CategoryCommands, CommandTemplate } from "@/lib/command-templates"
import { ANY_CATEGORY } from "@/lib/tools/types"

interface Draft { id: string; name: string; description: string; commands: CategoryCommands }
const blank: Draft = { id: "", name: "", description: "", commands: {} }
const fromTemplate = (t: CommandTemplate): Draft => ({ id: t.id, name: t.name, description: t.description, commands: { ...t.commands } })
const lines = (c: CategoryCommands) => Object.values(c).reduce((n, t) => n + t.split("\n").filter((l) => l.trim()).length, 0)
/** Compared after trimming, so a stray space does not count as an unsaved change. */
const sameDraft = (a: Draft, b: Draft) => {
  const norm = (d: Draft) => JSON.stringify([d.name.trim(), d.description.trim(),
    Object.entries(d.commands).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v).sort()])
  return norm(a) === norm(b)
}

export function TemplatesClient({ initial, categories }: { initial: CommandTemplate[]; categories: string[] }) {
  const toast = useToast()
  const router = useRouter()
  const [templates, setTemplates] = React.useState(initial)
  const [draft, setDraft] = React.useState<Draft>(() => (initial[0] ? fromTemplate(initial[0]) : blank))
  const [extra, setExtra] = React.useState<string[]>([])
  const [newCategory, setNewCategory] = React.useState("")
  const [confirm, setConfirm] = React.useState<{ title: string; text: string; action: string; run: () => void | Promise<void> } | null>(null)

  const saved = templates.find((t) => t.id === draft.id)
  const dirty = !sameDraft(draft, saved ? fromTemplate(saved) : blank)
  const clash = templates.find((t) => t.name.toLowerCase() === draft.name.trim().toLowerCase() && t.id !== draft.id)
  // Inventory categories first, then any the template keeps for devices not imported on this PC yet.
  const shown = [...new Set([...categories, ...Object.keys(draft.commands).filter((k) => k !== ANY_CATEGORY), ...extra])]
  const setCommands = (key: string, text: string) => setDraft((d) => ({ ...d, commands: { ...d.commands, [key]: text } }))

  /** Switching away from unsaved edits asks first - an hour of typed commands is not worth losing to a misclick. */
  const leave = (next: Draft) => {
    const go = () => { setDraft(next); setExtra([]) }
    if (dirty) setConfirm({ title: "Discard changes?", text: `"${draft.name || "New template"}" has changes that are not saved.`, action: "Discard", run: go })
    else go()
  }

  async function save() {
    const r = await saveCommandTemplate({ id: draft.id || undefined, name: draft.name, description: draft.description, commands: draft.commands })
    if (!r.ok) { toast({ body: r.error, type: "error" }); return }
    setTemplates((list) => [...list.filter((t) => t.id !== r.data.id && t.name !== r.data.name), r.data].sort((a, b) => a.name.localeCompare(b.name)))
    setDraft(fromTemplate(r.data))
    setExtra([])
    toast({ body: `Saved "${r.data.name}"` })
    router.refresh()
  }

  async function remove() {
    if (!draft.id) return
    const r = await removeCommandTemplate(draft.id)
    if (!r.ok) { toast({ body: r.error, type: "error" }); return }
    const rest = templates.filter((t) => t.id !== draft.id)
    setTemplates(rest)
    setDraft(rest[0] ? fromTemplate(rest[0]) : blank)
    toast({ body: `Deleted "${draft.name}"` })
    router.refresh()
  }

  function addCategory() {
    const c = newCategory.trim()
    if (!c || c === ANY_CATEGORY) return
    if (!shown.includes(c)) setExtra((x) => [...x, c])
    setNewCategory("")
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
      <Panel title={`Templates (${templates.length})`} className="h-fit"
        actions={<Button variant="secondary" size="sm" label="New" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => leave(blank)} />}>
        {templates.length === 0 ? (
          <p className="text-muted-foreground text-sm">No templates yet. Fill in the form and press Save.</p>
        ) : (
          <ul className="-mx-2 flex flex-col gap-0.5">
            {templates.map((t) => (
              <li key={t.id}>
                <button type="button" onClick={() => t.id !== draft.id && leave(fromTemplate(t))}
                  className={`hover:bg-muted w-full rounded-lg px-2 py-1.5 text-left ${t.id === draft.id ? "bg-muted font-medium" : ""}`}>
                  <span className="block truncate text-sm">{t.name}</span>
                  <span className="text-muted-foreground block truncate text-xs">
                    {Object.keys(t.commands).length} categor{Object.keys(t.commands).length === 1 ? "y" : "ies"} · {lines(t.commands)} command(s)
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title={draft.id ? draft.name || saved?.name : "New template"}
        actions={dirty ? <Badge label="Unsaved" variant="warning" /> : undefined}>
        <div className="grid grid-cols-1 gap-x-5 gap-y-4 md:grid-cols-2">
          <TextInput label="Name" value={draft.name} isRequired onChange={(v) => setDraft((d) => ({ ...d, name: v }))}
            placeholder="e.g. Pre-check before upgrade"
            description={clash ? `Saving replaces the existing template "${clash.name}".` : undefined} />
          <TextInput label="Description" value={draft.description} isOptional onChange={(v) => setDraft((d) => ({ ...d, description: v }))}
            placeholder="What these commands are for" />
        </div>

        <div className="mt-4">
          <TextArea label="Every other Device Category" rows={5} hasSpellCheck={false} value={draft.commands[ANY_CATEGORY] ?? ""}
            onChange={(v) => setCommands(ANY_CATEGORY, v)} placeholder={"show version\nshow ip interface brief"}
            description="One command per line. Used by every category below that is left empty." />
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
          {shown.map((c) => (
            <TextArea key={c} label={c} rows={4} hasSpellCheck={false} value={draft.commands[c] ?? ""}
              onChange={(v) => setCommands(c, v)} placeholder="empty = use the list above" />
          ))}
        </div>
        {shown.length === 0 && (
          <p className="text-muted-foreground mt-2 text-sm">No Device Categories in Site Inventory yet - add one by name below, or import a device list first.</p>
        )}

        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="w-full max-w-xs">
            <TextInput label="Add a Device Category" value={newCategory} onChange={setNewCategory} isOptional
              placeholder="e.g. WLC" />
          </div>
          <Button variant="secondary" label="Add" icon={<Plus className="h-3.5 w-3.5" />} isDisabled={!newCategory.trim()} onClick={addCategory} />
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <Button variant="primary" label="Save" icon={<Save className="h-3.5 w-3.5" />} isDisabled={!draft.name.trim() || !dirty}
            clickAction={async () => {
              if (clash) setConfirm({ title: "Replace template?", text: `A template named "${clash.name}" already exists. Saving replaces it.`, action: "Replace", run: save })
              else await save()
            }} />
          {draft.id && (
            <Button variant="secondary" label="Duplicate" icon={<Copy className="h-3.5 w-3.5" />}
              onClick={() => setDraft({ ...draft, id: "", name: `${draft.name} (copy)` })} />
          )}
          {draft.id && (
            <Button variant="secondary" label="Delete" icon={<Trash2 className="h-3.5 w-3.5" />}
              onClick={() => setConfirm({ title: "Delete template?", text: `"${draft.name}" will be deleted. Tool forms that already loaded it keep their commands.`, action: "Delete", run: remove })} />
          )}
        </div>
      </Panel>

      {confirm && (
        <AlertDialog isOpen onOpenChange={(open) => { if (!open) setConfirm(null) }} title={confirm.title} description={confirm.text}
          cancelLabel="Cancel" actionLabel={confirm.action} actionVariant="destructive"
          onAction={async () => { const c = confirm; setConfirm(null); await c.run() }} />
      )}
    </div>
  )
}
