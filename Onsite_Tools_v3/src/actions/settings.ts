"use server"

import { revalidatePath } from "next/cache"
import { saveSettings, type AppSettings } from "@/lib/settings"

export async function updateSettings(patch: Partial<AppSettings>) {
  const saved = await saveSettings(patch)
  revalidatePath("/", "layout")
  return saved
}
