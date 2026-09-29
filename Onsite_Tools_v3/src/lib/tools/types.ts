import type { JobContext } from "../jobs"

export type FieldType = "text" | "password" | "number" | "textarea" | "checkbox" | "select" | "file" | "files" | "path"
  /** One command box per Device Category in Site Inventory, plus one for everything else. */
  | "commandsPerCategory"
  /** Pick several options at once (Device list, Device Category); the value is a string[]. */
  | "multiSelect"

export interface Option { value: string; label: string }

/** Key for "every Device Category without a list of its own" in a commandsPerCategory field. */
export const ANY_CATEGORY = "*"

export interface FieldDef {
  name: string
  label: string
  type: FieldType
  required?: boolean
  default?: string | number | boolean | string[] | Record<string, string>
  /** Filled from Settings (key) when the form opens. */
  defaultFrom?: "username" | "deviceType" | "threads" | "snmpCommunity" | "localIp"
  placeholder?: string
  help?: string
  width?: "half" | "full"
  min?: number
  max?: number
  rows?: number
  accept?: string
  /** Template file offered next to an upload field. */
  template?: string
  options?: Option[] | "deviceTypes"
  /** Options loaded from Site Inventory. `dependsOn` = name of the list field for a site selector. */
  source?: { type: "inventoryLists" } | { type: "inventorySites"; dependsOn: string }
  showCount?: boolean
  showIf?: Record<string, string>
  /** Remembered in the browser together with the credentials. */
  remember?: boolean
  kind?: "file" | "folder"
  /** Native file dialog (the app runs on the user's own PC): dialog title and a Windows filter string. */
  browseTitle?: string
  browseFilter?: string
}

export interface RunDef {
  id: string
  label: string
  params?: Record<string, unknown>
  danger?: boolean
  /** `{count}` is replaced with the number of devices the run would touch. */
  confirm?: string
  /** Ask for confirmation only when the form is in this state, e.g. { mode: "Config mode" }. */
  confirmIf?: Record<string, string>
  /** Offer this button only when the form is in this state (all keys must match). */
  showIf?: Record<string, string>
  /** Hide this button when the form is in this state - the mirror of showIf, for the run it replaces. */
  hideIf?: Record<string, string>
  notice?: string
  /** Fields this run does not need, although the form marks them required (e.g. flash cleanup needs no image). */
  optionalFields?: string[]
}

export type Params = Record<string, unknown>

export interface ToolDef {
  id: string
  name: string
  category: string
  description: string
  order: number
  icon: string
  fields: FieldDef[]
  columns: string[]
  runs: RunDef[]
  /** Runs of this tool share one log folder and one results table until the user presses Done. */
  session?: boolean
  /** Show the newest row at the top of the results - for a run that goes on, the last thing that happened matters most. */
  latestFirst?: boolean
  /** Fold the results under this column, one group per value (e.g. one drop-down per device). */
  groupBy?: string
  run: (ctx: JobContext, params: Params) => Promise<void>
}

/** What the browser needs - no functions. */
export type PublicTool = Omit<ToolDef, "run">

export const str = (v: unknown, d = ""): string => (v === undefined || v === null ? d : String(v))

/**
 * The command list for one device, out of a per-Device-Category field. A category with a list of its own
 * uses it; anything else falls back to ANY_CATEGORY. A box left blank - or cleared back to spaces - means
 * "use the list above", not "run nothing". A plain string (what these fields held before they were split
 * per category) is taken as that fallback.
 */
export function commandsForCategory(value: unknown, category: string): string[] {
  const lists = value && typeof value === "object" ? (value as Record<string, unknown>) : null
  const text = typeof value === "string" ? value
    : lists ? str(lists[category]).trim() || str(lists[ANY_CATEGORY])
    : ""
  return text.split(/\r?\n/).map((c) => c.trim()).filter(Boolean)
}
export const num = (v: unknown, d: number): number => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d }
export const bool = (v: unknown): boolean => v === true || v === "true" || v === "on"

export const INVENTORY_FIELDS: FieldDef[] = [
  // Multi-select: an upgrade evening covers two or three lists, and "nothing picked" means all of them.
  { name: "inventoryList", label: "Device list (Site Inventory)", type: "multiSelect", default: [], width: "half",
    source: { type: "inventoryLists" }, placeholder: "All device lists", help: "Lists are imported in the Site Inventory menu." },
  { name: "site", label: "Device Category", type: "multiSelect", default: [], width: "half",
    source: { type: "inventorySites", dependsOn: "inventoryList" }, placeholder: "All categories", showCount: true },
]

export const COMMON_DEVICE_FIELDS: FieldDef[] = [
  ...INVENTORY_FIELDS,
  { name: "username", label: "Username", type: "text", required: true, width: "half", defaultFrom: "username", remember: true },
  { name: "password", label: "Password", type: "password", required: true, width: "half", remember: true },
  { name: "deviceType", label: "Device type", type: "select", width: "half", default: "autodetect", defaultFrom: "deviceType",
    options: "deviceTypes", help: "autodetect tries Cisco, Huawei, HPE and Juniper paging commands. A Device_Type stored in Site Inventory overrides this." },
  { name: "threads", label: "Max parallel sessions", type: "number", min: 1, max: 100, width: "half", default: 10, defaultFrom: "threads" },
]
