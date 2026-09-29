import { describe, expect, it } from "vitest"
import { TOOLS, getTool, publicTool } from "@/lib/tools"
import { commandsFor } from "@/lib/tools/ssh-tools"
import { flashName } from "@/lib/tools/upgrade-ios"

const DEVICE_TOOLS = ["config-devices", "upgrade-ios", "client-status-checker", "get-inventory", "cdp-inventory", "lldp-inventory",
  "snmp-inventory", "verify-snmp-user", "dnac-port-assignment"]

describe("tool registry", () => {
  it("has the 15 tools with unique ids and serialisable metadata", () => {
    expect(TOOLS).toHaveLength(15)
    expect(new Set(TOOLS.map((t) => t.id)).size).toBe(15)
    for (const t of TOOLS) {
      expect(new Set(t.fields.map((f) => f.name)).size).toBe(t.fields.length)
      expect(JSON.parse(JSON.stringify(publicTool(t)))).not.toHaveProperty("run")
      expect(t.runs.length).toBeGreaterThan(0)
    }
  })

  it("device tools read from Site Inventory and never upload a device CSV", () => {
    for (const id of DEVICE_TOOLS) {
      const names = getTool(id)!.fields.map((f) => f.name)
      expect(names, id).toEqual(expect.arrayContaining(["inventoryList", "site"]))
      expect(names).not.toContain("deviceFile")
    }
  })

  it("no password field ships with a default value", () => {
    for (const t of TOOLS) for (const f of t.fields) if (f.type === "password") expect(f.default ?? "").toBe("")
  })

  it("the IOS runs that destroy something must be confirmed", () => {
    const runs = getTool("upgrade-ios")!.runs
    const byId = Object.fromEntries(runs.map((r) => [r.id, r]))
    expect(runs.map((r) => r.params?.stage)).toEqual([0, 1, 2, 3, 8, 9, 10, 11, 4, 5, 6, 7])
    // Everything that reloads a device or deletes files from flash asks first.
    for (const id of ["stage3", "stage3c", "cleanup-remove"]) {
      expect(byId[id], id).toMatchObject({ danger: true })
      expect(byId[id].confirm, id).toBeTruthy()
    }
    // Reading is never behind a dialog; the manual steps that change something ask but are not "danger".
    expect(byId["cleanup-list"].danger).toBeFalsy()
    expect(byId["cleanup-list"].confirm).toBeFalsy()
    for (const id of ["stage3a", "stage3b", "stage3d"]) {
      expect(byId[id].confirm, id).toBeTruthy()
      expect(byId[id].danger, id).toBeFalsy()
    }
    // Cleanup and the manual steps work on what is already on flash, so they must not demand an image on this PC.
    for (const id of ["cleanup-list", "cleanup-remove", "stage3a", "stage3c", "stage3d"]) {
      expect(byId[id].optionalFields, id).toContain("iosFile")
    }
    expect(byId["stage3b"].optionalFields).toBeUndefined() // "install add file flash:<name>" needs the name
    expect(flashName("C:\\ftp\\cat9k_iosxe 17.09.bin")).toBe("cat9k-iosxe-17.09.bin")
  })

  it("Stage 3 is either the one-shot button or the four manual ones, never both", () => {
    const runs = getTool("upgrade-ios")!.runs
    const manual = { installMethod: "install", installStyle: "manual" }
    const shown = (state: Record<string, string>) => runs
      .filter((r) => (!r.showIf || Object.entries(r.showIf).every(([k, v]) => state[k] === v))
        && !(r.hideIf && Object.entries(r.hideIf).every(([k, v]) => state[k] === v)))
      .map((r) => r.id)

    expect(shown(manual)).toContain("stage3a")
    expect(shown(manual)).not.toContain("stage3")
    const others: Record<string, string>[] = [{ installMethod: "install", installStyle: "one-shot" }, { installMethod: "reload" }, {}]
    for (const state of others) {
      expect(shown(state), JSON.stringify(state)).toContain("stage3")
      for (const id of ["stage3a", "stage3b", "stage3c", "stage3d"]) expect(shown(state), id).not.toContain(id)
    }
    // The mode picker only appears for install mode, where it means something.
    expect(getTool("upgrade-ios")!.fields.find((f) => f.name === "installStyle")?.showIf).toEqual({ installMethod: "install" })
  })

  it("Config mode asks before it changes devices, Verify mode does not", () => {
    const run = getTool("config-devices")!.runs[0]
    expect(run.confirmIf).toEqual({ mode: "Config mode" })
    expect(run.confirm).toContain("{count}") // the dialog names how many devices it would touch
    expect(run.confirm).toMatch(/configure terminal/)
    // A read-only run must never sit behind a dialog.
    for (const id of ["get-inventory", "cdp-inventory", "client-status-checker"]) {
      for (const r of getTool(id)!.runs) expect(r.confirm, id).toBeFalsy()
    }
  })

  it("Config Devices gives each Device Category its own command list", () => {
    const wlc = { host: "10.0.0.9", site: "WLC", deviceType: "", hostname: "", description: "", raw: {} }
    const access = { host: "10.0.0.8", site: "ASW", deviceType: "", hostname: "", description: "", raw: {} }
    const lists = { "*": "show version", WLC: "show ap summary\nshow wlan summary", ASW: "   " }
    expect(commandsFor(wlc, lists, false)).toEqual(["show ap summary", "show wlan summary"])
    expect(commandsFor(access, lists, false)).toEqual(["show version"])  // blank list of its own = use the default
    // A device carrying its own command column still wins over the category list.
    expect(commandsFor({ ...wlc, raw: { command: "show redundancy" } }, lists, true)).toEqual(["show redundancy"])
    // ...but an empty column falls back instead of running nothing.
    expect(commandsFor({ ...wlc, raw: { command: "  " } }, lists, true)).toEqual(["show ap summary", "show wlan summary"])
  })

  it("Config Devices picks per-device commands only when asked", () => {
    const d = { host: "10.0.0.1", site: "", deviceType: "", hostname: "", description: "", raw: { command: "show clock\nshow ver" } }
    expect(commandsFor(d, "show ip int br", true)).toEqual(["show clock", "show ver"])
    expect(commandsFor(d, "show ip int br", false)).toEqual(["show ip int br"])
    expect(commandsFor({ ...d, raw: {} }, "show ip int br", true)).toEqual(["show ip int br"])
  })
})
