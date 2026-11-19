import { describe, expect, it } from "vitest"
import { getSite, listDevices, listSites } from "@/lib/data"

describe("data layer (sample data)", () => {
  it("summarises device counts per site", async () => {
    const sites = await listSites()
    const dc = sites.find((s) => s.code === "BKK-DC1")!
    expect(dc.deviceCount).toBe(5)
    expect(dc.devicesWarning).toBe(1)
  })

  it("finds a site by code, case-insensitively, with its children", async () => {
    const site = await getSite("hkt-br02")
    expect(site?.devices.every((d) => d.siteId === site.id)).toBe(true)
    expect(site?.subnets.length).toBeGreaterThan(0)
    expect(await getSite("NOPE")).toBeNull()
  })

  it("gives every device a unique management IP", async () => {
    const ips = (await listDevices()).map((d) => d.mgmtIp)
    expect(new Set(ips).size).toBe(ips.length)
  })
})
