import { describe, expect, it } from "vitest"
import { cleanCommands, commandCount, parseCommands } from "@/lib/command-templates"
import { ANY_CATEGORY, commandsForCategory } from "@/lib/tools/types"

describe("Command Templates", () => {
  it("keeps one command per line and drops blank lines, trailing spaces and empty categories", () => {
    expect(cleanCommands({
      [ANY_CATEGORY]: "show version  \r\n\r\nshow ip int brief\n",
      " WLC ": "show wlan summary",
      ASW: "   \n  ",
    })).toEqual({ [ANY_CATEGORY]: "show version\nshow ip int brief", WLC: "show wlan summary" })
  })

  it("keeps the indentation of a command - config sub-modes need it", () => {
    expect(cleanCommands({ SS: "interface Gi1/0/1\n description uplink" })).toEqual({ SS: "interface Gi1/0/1\n description uplink" })
  })

  it("takes a plain string as the list for every category, as the form fields did before they were split", () => {
    expect(cleanCommands("show clock")).toEqual({ [ANY_CATEGORY]: "show clock" })
  })

  it("ignores what is not a category -> text map", () => {
    expect(cleanCommands(["show clock"])).toEqual({})
    expect(cleanCommands({ SS: 42, "": "show clock" })).toEqual({})
    expect(parseCommands("not json")).toEqual({})
  })

  it("loads into a form the way the run reads it: own list first, the rest fall back", () => {
    const loaded = parseCommands(JSON.stringify({ [ANY_CATEGORY]: "show version", WLC: "show ap summary\nshow wlan summary" }))
    expect(commandsForCategory(loaded, "WLC")).toEqual(["show ap summary", "show wlan summary"])
    expect(commandsForCategory(loaded, "ASW")).toEqual(["show version"])
    expect(commandCount(loaded)).toBe(3)
  })
})
