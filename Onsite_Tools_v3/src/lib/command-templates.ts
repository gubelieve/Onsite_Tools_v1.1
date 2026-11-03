/** Command Templates - saved command lists per Device Category, loaded into a tool's commandsPerCategory field. */
import prisma from "./prisma"
import { ANY_CATEGORY } from "./tools/types"

export type CategoryCommands = Record<string, string>

export interface CommandTemplate {
  id: string
  name: string
  description: string
  commands: CategoryCommands
  updatedAt: string
}

export interface TemplateInput {
  id?: string
  name: string
  description?: string
  commands: unknown
}

/**
 * The shape both the form and the database keep: one text block per category, each line one command,
 * trailing spaces and blank lines dropped. A category left empty is left out - in the form that means
 * "use the list for every category", which is what commandsForCategory does with a missing key.
 */
export function cleanCommands(input: unknown): CategoryCommands {
  const src = typeof input === "string" ? { [ANY_CATEGORY]: input }
    : input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
  const out: CategoryCommands = {}
  for (const [rawKey, value] of Object.entries(src)) {
    const key = rawKey.trim()
    if (!key || typeof value !== "string") continue
    const text = value.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim()).join("\n")
    if (text) out[key] = text
  }
  return out
}

export function parseCommands(json: string): CategoryCommands {
  try { return cleanCommands(JSON.parse(json)) } catch { return {} }
}

/** How many command lines a template sends, over all its categories - shown in the menus. */
export const commandCount = (c: CategoryCommands) => Object.values(c).reduce((n, t) => n + t.split("\n").length, 0)

const toTemplate = (r: { id: string; name: string; description: string; commands: string; updatedAt: Date }): CommandTemplate =>
  ({ id: r.id, name: r.name, description: r.description, commands: parseCommands(r.commands), updatedAt: r.updatedAt.toLocaleString("sv-SE") })

export async function listTemplates(): Promise<CommandTemplate[]> {
  const rows = await prisma.commandTemplate.findMany({ orderBy: { name: "asc" } }).catch(() => [])
  return rows.map(toTemplate)
}

/**
 * Create, or update by id. Saving under a name another template already has replaces that one - the
 * form says so before the button is pressed, so this is never a surprise.
 */
export async function saveTemplate(input: TemplateInput): Promise<CommandTemplate> {
  const name = String(input.name ?? "").trim()
  if (!name) throw new Error("Give the template a name")
  if (name.length > 80) throw new Error("Keep the name under 80 characters")
  const commands = cleanCommands(input.commands)
  if (!Object.keys(commands).length) throw new Error("Add at least one command")
  const data = { name, description: String(input.description ?? "").trim(), commands: JSON.stringify(commands) }
  // "WLC check" and "wlc check" are one template, as the forms say - SQLite's unique index alone would keep both.
  const all = await prisma.commandTemplate.findMany({ select: { id: true, name: true } })
  const sameName = all.find((t) => t.name.toLowerCase() === name.toLowerCase())
  if (input.id) {
    if (sameName && sameName.id !== input.id) await prisma.commandTemplate.delete({ where: { id: sameName.id } })
    return toTemplate(await prisma.commandTemplate.update({ where: { id: input.id }, data }))
  }
  return toTemplate(sameName
    ? await prisma.commandTemplate.update({ where: { id: sameName.id }, data })
    : await prisma.commandTemplate.create({ data }))
}

export async function deleteTemplate(id: string) {
  await prisma.commandTemplate.delete({ where: { id } })
}
