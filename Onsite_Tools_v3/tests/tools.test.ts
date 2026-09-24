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
    expect(runs.map((r) => r.params?.stage)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    // Installing (reload) and deleting files from flash; listing what would be deleted is not one of them.
    for (const i of [3, 7]) {
      expect(runs[i], runs[i].label).toMatchObject({ danger: true })
      expect(runs[i].confirm, runs[i].label).toBeTruthy()
    }
    expect(runs[6].danger).toBeFalsy()
    expect(runs[6].confirm).toBeFalsy()
    // Cleanup works on what is already on flash, so it must not demand an image on this PC.
    for (const i of [6, 7]) expect(runs[i].optionalFields).toContain("iosFile")
    expect(flashName("C:\\ftp\\cat9k_iosxe 17.09.bin")).toBe("cat9k-iosxe-17.09.bin")
  })

  it("Config Devices picks per-device commands only when asked", () => {
    const d = { host: "10.0.0.1", site: "", deviceType: "", hostname: "", description: "", raw: { command: "show clock\nshow ver" } }
    expect(commandsFor(d, "show ip int br", true)).toEqual(["show clock", "show ver"])
    expect(commandsFor(d, "show ip int br", false)).toEqual(["show ip int br"])
    expect(commandsFor({ ...d, raw: {} }, "show ip int br", true)).toEqual(["show ip int br"])
  })
})
