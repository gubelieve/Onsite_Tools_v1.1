"use server"

import { revalidatePath } from "next/cache"
import { deleteTemplate, saveTemplate, type CommandTemplate, type TemplateInput } from "@/lib/command-templates"

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

export async function saveCommandTemplate(input: TemplateInput): Promise<Result<CommandTemplate>> {
  return guard(() => saveTemplate(input))
}

export async function removeCommandTemplate(id: string): Promise<Result<true>> {
  return guard(async () => { await deleteTemplate(id); return true as const })
}
