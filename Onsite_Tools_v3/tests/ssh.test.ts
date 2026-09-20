import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { AuthError, SshSession, classifyError, cleanOutput, hostnameFromPrompt, promptRegex } from "@/lib/net/ssh"
import { startFakeDevice, type FakeDevice } from "./fake-device"

describe("prompt helpers", () => {
  it("extracts the hostname from any prompt form", () => {
    expect(hostnameFromPrompt("SW-CORE-01#")).toBe("SW-CORE-01")
    expect(hostnameFromPrompt("SW-CORE-01(config-if)#")).toBe("SW-CORE-01")
    expect(hostnameFromPrompt("<HUAWEI-SW>")).toBe("HUAWEI-SW")
    expect(hostnameFromPrompt("admin@junos-1>")).toBe("junos-1")
  })

  it("matches exec and config prompts but not output that merely ends with #", () => {
    const re = promptRegex("SW1#")
    expect(re.test("some output\r\nSW1#")).toBe(true)
    expect(re.test("some output\r\nSW1(config-if)# ")).toBe(true)
    expect(re.test("interface description uplink #")).toBe(false)
    expect(re.test("other-device#")).toBe(false)
  })

  it("strips the echoed command and the trailing prompt", () => {
    expect(cleanOutput("show clock\r\n*10:15:01 ICT\r\nSW1#", "show clock")).toBe("*10:15:01 ICT")
  })

  it("classifies errors for the status column", () => {
    expect(classifyError(new AuthError("Authentication failed."))).toBe("Authentication failed.")
    expect(classifyError(new Error("Timed out while waiting for handshake"))).toBe("Connection timeout")
    expect(classifyError(new Error("connect ECONNREFUSED"))).toBe("Connection Error")
  })
})

describe("SshSession against a fake Cisco device", () => {
  let dev: FakeDevice
  const open = (extra = {}) => SshSession.open({ host: "127.0.0.1", port: dev.port, username: "admin", password: "secret", timeoutSec: 10, ...extra })
  beforeAll(async () => { dev = await startFakeDevice() })
  afterAll(async () => { await dev.close() })

  it("learns the prompt, disables paging and returns clean command output", async () => {
    const s = await open({ deviceType: "cisco_ios" })
    try {
      expect(s.hostname).toBe("SW-LAB-01")
      expect(dev.commands).toContain("terminal length 0")
      const out = await s.send("show version")
      expect(out.startsWith("Cisco IOS XE Software, Version 17.09.04a")).toBe(true)
      expect(out).not.toContain("SW-LAB-01#")
      expect(out).not.toMatch(/^show version/)
      expect(await s.send("show clock")).toBe("*10:15:01.123 ICT Sat Sep 20 2026")
    } finally { s.close() }
  })

  it("autodetect settles on cisco_ios because 'terminal length 0' is accepted", async () => {
    const s = await open({ deviceType: "autodetect" })
    try { expect(s.detectedType).toBe("cisco_ios") } finally { s.close() }
  })

  it("follows the prompt into and out of config mode", async () => {
    const s = await open({ deviceType: "cisco_ios" })
    try {
      await s.sendConfig(["hostname SW-LAB-01", "ntp server 10.0.0.1"])
      expect(dev.commands.slice(-4)).toEqual(["configure terminal", "hostname SW-LAB-01", "ntp server 10.0.0.1", "end"])
      expect(await s.send("show clock")).toContain("ICT") // back in exec mode and still in sync
    } finally { s.close() }
  })

  it("reports a wrong password as an authentication failure", async () => {
    const err = await open({ password: "wrong" }).then(() => null, (e) => e)
    expect(classifyError(err)).toBe("Authentication failed.")
  })
})
