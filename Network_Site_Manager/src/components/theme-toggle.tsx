"use client"

import { Moon, Sun } from "lucide-react"
import { IconButton } from "@astryxdesign/core/IconButton"
import { useThemeMode } from "@/app/providers"

/**
 * The one-click flip in the account pill, beside the bell. It sets an EXPLICIT
 * light or dark (leaving "system" behind on purpose — a person who reaches for
 * the button wants a side, not a policy); the three-way choice, System
 * included, stays in the user menu. The icon shows where the click GOES, not
 * where you are: a moon on a light screen, a sun on a dark one.
 */
export function ThemeToggle() {
  const { resolved, setMode } = useThemeMode()
  const dark = resolved === "dark"
  return (
    <IconButton
      variant="ghost"
      size="sm"
      label={dark ? "Switch to light mode" : "Switch to dark mode"}
      tooltip={dark ? "Light mode" : "Dark mode"}
      icon={dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      onClick={() => setMode(dark ? "light" : "dark")}
    />
  )
}
