import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { looksLikeDiff, parseUnified } from "@/lib/diff-format"
import { anchorsOf, byCommand, compareConfig, compileIgnore, DEFAULT_IGNORE, DEFAULT_SKIP, diffLines, isSkipped, maskSecrets, normalize, scanFolder, splitSections, unifiedDiff } from "@/lib/tools/compare-config"

const lines = (s: string) => s.trim().split("\n")

describe("diff engine", () => {
  it("keeps what stayed and marks what went and what came", () => {
    const ops = diffLines(["a", "b", "c"], ["a", "x", "c"])
    expect(ops.map((o) => o.type + o.line)).toEqual(["=a", "-b", "+x", "=c"])
  })

  it("handles insertions, deletions and empty sides", () => {
    expect(diffLines(["a", "c"], ["a", "b", "c"]).map((o) => o.type + o.line)).toEqual(["=a", "+b", "=c"])
    expect(diffLines(["a", "b", "c"], ["a", "c"]).map((o) => o.type + o.line)).toEqual(["=a", "-b", "=c"])
    expect(diffLines([], ["a"]).map((o) => o.type + o.line)).toEqual(["+a"])
    expect(diffLines(["a"], []).map((o) => o.type + o.line)).toEqual(["-a"])
    expect(diffLines([], [])).toEqual([])
  })

  it("finds the minimal change in a long file quickly", () => {
    const before = Array.from({ length: 5000 }, (_, i) => `line ${i}`)
    const after = [...before]
    after[2500] = "line 2500 CHANGED"
    const started = Date.now()
    const { added, removed, text } = unifiedDiff(before, after)
    expect({ added, removed }).toEqual({ added: 1, removed: 1 })
    expect(text).toContain("-line 2500")
    expect(text).toContain("+line 2500 CHANGED")
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it("writes a unified diff with line numbers and context", () => {
    const before = lines(`
hostname SW1
!
interface Gi1/0/1
 description USER
 switchport access vlan 10
!
logging host 10.1.1.1`)
    const after = lines(`
hostname SW1
!
interface Gi1/0/1
 description PRINTER
 switchport access vlan 20
!
logging host 10.1.1.1`)
    const { text, added, removed } = unifiedDiff(before, after, 1)
    expect({ added, removed }).toEqual({ added: 2, removed: 2 })
    expect(text.split("\n")).toEqual([
      "@@ -3,4 +3,4 @@",
      " interface Gi1/0/1",
      "- description USER",
      "- switchport access vlan 10",
      "+ description PRINTER",
      "+ switchport access vlan 20",
      " !",
    ])
    expect(unifiedDiff(before, before).text).toBe("")
  })
})

describe("what counts as a difference", () => {
  it("drops the lines that change by themselves", () => {
    const ignore = compileIgnore(DEFAULT_IGNORE.join("\n"))
    const text = "Building configuration...\n\nCurrent configuration : 4231 bytes\n! Last configuration change at 10:15:01 by admin\nhostname SW1\nntp clock-period 17179860\n"
    expect(normalize(text, ignore)).toEqual(["hostname SW1"])
    // Without the ignore list the noise is a difference like any other.
    expect(normalize(text, [])).toHaveLength(5)
  })

  it("ignores trailing whitespace, and a broken pattern does not stop the run", () => {
    expect(normalize("a  \nb\t\n", [])).toEqual(["a", "b"])
    expect(compileIgnore("valid\n[unclosed\n")).toHaveLength(1)
  })
})

describe("Compare Configuration - end to end on real log folders", () => {
  type Row = Record<string, unknown>
  const fakeCtx = (runDir: string) => {
    const rows: Row[] = []
    const messages: string[] = []
    return {
      rows, messages,
      ctx: {
        addRow: (r: Row) => { rows.push(r); return String(rows.length) },
        updateRow: () => undefined,
        setColumns: () => undefined,
        progress: () => undefined,
        step: () => undefined,
        checkStop: () => undefined,
        summary: (t: string) => messages.push(`summary: ${t}`),
        info: (t: string) => messages.push(`info: ${t}`),
        warn: (t: string) => messages.push(`warn: ${t}`),
        error: (t: string) => messages.push(`error: ${t}`),
        artifact: (name: string) => messages.push(`artifact: ${name}`),
        log: () => undefined,
        runDir,
        stopRequested: false,
      },
    }
  }

  const base = fs.mkdtempSync(path.join(os.tmpdir(), "onsite-compare-"))
  const write = (dir: string, name: string, body: string) => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, name), body, "utf8")
  }
  const beforeDir = path.join(base, "before"), afterDir = path.join(base, "after"), runDir = path.join(base, "run")
  fs.mkdirSync(runDir, { recursive: true })

  // Same layout Config Devices writes: <hostname>-<ip>_<stamp>.log, a command list, then one section per command.
  const coreLog = (logging: string, age: string, version: string) => [
    "[Command List]", "show version", "show run", "show ip route", "",
    "--- show version ---", "Building configuration...", version, "SW-CORE uptime is 3 weeks",
    "--- show run ---", "hostname SW-CORE", logging, "ntp clock-period 1",
    "----- -----              ----------", // a separator inside the output, not a command header
    "--- show ip route ---", `O E1 10.1.92.0/24 [110/5024] via 10.14.110.10, ${age}, Gi1/0/1`, "",
  ].join("\n")
  write(beforeDir, "SW-CORE-10.0.0.1_2026-09-20_100000.log", coreLog("logging host 10.1.1.1", "2w5d", "Version 17.3.3"))
  write(afterDir, "SW-CORE-10.0.0.1_2026-09-21_100000.log", coreLog("logging host 10.9.9.9", "00:05:13", "Version 17.15.5"))
  write(beforeDir, "SW-EDGE-10.0.0.2_2026-09-20_100000.log", "hostname SW-EDGE\nvlan 10\n")
  write(afterDir, "SW-EDGE-10.0.0.2_2026-09-21_100000.log", "hostname SW-EDGE\nvlan 10\n")
  write(beforeDir, "SW-GONE-10.0.0.3_2026-09-20_100000.log", "hostname SW-GONE\n")
  write(afterDir, "SW-NEW-10.0.0.4_2026-09-21_100000.log", "hostname SW-NEW\n")
  write(afterDir, "job.log", "2026-09-21 - INFO - the run's own log, not a device")

  it("matches devices by IP and ignores the run's own log", () => {
    expect([...scanFolder(beforeDir).keys()].sort()).toEqual(["10.0.0.1", "10.0.0.2", "10.0.0.3"])
    expect([...scanFolder(afterDir).keys()].sort()).toEqual(["10.0.0.1", "10.0.0.2", "10.0.0.4"])
  })

  it("reports one row per command that changed, and leaves the volatile ones out", async () => {
    const { rows, messages, ctx } = fakeCtx(runDir)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await compareConfig.run(ctx as any, { beforeFolder: beforeDir, afterFolder: afterDir, ignore: DEFAULT_IGNORE.join("\n"),
      skip: DEFAULT_SKIP.join("\n"), context: 3 })

    const core = rows.filter((r) => r["IP Address"] === "10.0.0.1")
    expect(core.map((r) => r.Command), JSON.stringify(rows, null, 1)).toEqual(["show version", "show run"])
    expect(core[0]).toMatchObject({ Device: "SW_CORE", Status: "Changed" })
    expect(String(core[0].Diff)).toContain("+Version 17.15.5")
    const showRun = core[1]
    expect(showRun).toMatchObject({ Status: "Changed", "Lines Added": "1", "Lines Removed": "1" })
    expect(String(showRun.Diff)).toContain("-logging host 10.1.1.1")
    expect(String(showRun.Diff)).toContain("+logging host 10.9.9.9")
    // "ntp clock-period" differs but is on the ignore list; the separator line is not a command of its own.
    expect(String(showRun.Diff)).not.toContain("ntp clock-period")
    expect(rows.map((r) => r.Command)).not.toContain("----- -----              ----------")
    // The routing table changed only because the route ages did - it must not be reported at all.
    expect(rows.some((r) => String(r.Command).includes("show ip route"))).toBe(false)
    expect(messages.join(" | ")).toMatch(/Skipped 1 command\(s\).*show ip route/)

    expect(rows.find((r) => r["IP Address"] === "10.0.0.2")).toMatchObject({ Command: "(all commands)", Status: "Same" })
    expect(rows.find((r) => r["IP Address"] === "10.0.0.3")).toMatchObject({ Status: "Missing in After" })
    expect(rows.find((r) => r["IP Address"] === "10.0.0.4")).toMatchObject({ Status: "New in After" })
    expect(messages).toContain("summary: 1 device(s) changed (2 command(s)), 1 unchanged, 2 on one side only")

    const written = fs.readdirSync(runDir)
    expect(written.filter((f) => f.endsWith(".diff")).length).toBe(2) // one per changed device + the combined report
    const perDevice = fs.readFileSync(path.join(runDir, "SW_CORE-10.0.0.1.diff"), "utf8")
    expect(perDevice).toContain("### show run")
    expect(perDevice).toContain("+logging host 10.9.9.9")
    expect(messages.some((m) => m.startsWith("artifact: compare_"))).toBe(true)
  })

  it("compares even the noisy commands once the skip list is cleared", async () => {
    const { rows, ctx } = fakeCtx(runDir)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await compareConfig.run(ctx as any, { beforeFolder: beforeDir, afterFolder: afterDir, skip: "", onlyChanged: true })
    expect(rows.map((r) => r.Command)).toContain("show ip route")
  })

  it("only lists the devices that changed when asked to", async () => {
    const { rows, ctx } = fakeCtx(runDir)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await compareConfig.run(ctx as any, { beforeFolder: beforeDir, afterFolder: afterDir, onlyChanged: true })
    expect([...new Set(rows.map((r) => r["IP Address"]))]).toEqual(["10.0.0.1"])
  })

  it("refuses two folders that are the same, or a folder that is not there", async () => {
    const same = fakeCtx(runDir)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await compareConfig.run(same.ctx as any, { beforeFolder: beforeDir, afterFolder: beforeDir })
    expect(same.rows).toHaveLength(0)
    expect(same.messages.join()).toMatch(/same folder/i)

    const missing = fakeCtx(runDir)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await compareConfig.run(missing.ctx as any, { beforeFolder: path.join(base, "nope"), afterFolder: afterDir })
    expect(missing.messages.join()).toMatch(/Before folder not found/)
  })
})

describe("side-by-side view", () => {
  it("pairs a removed line with the added one that replaced it", () => {
    const text = unifiedDiff(["a", "old", "c"], ["a", "new", "c"], 1).text
    expect(parseUnified(text)).toEqual([
      { type: "same", left: { no: 1, text: "a" }, right: { no: 1, text: "a" } },
      { type: "chg", left: { no: 2, text: "old" }, right: { no: 2, text: "new" } },
      { type: "same", left: { no: 3, text: "c" }, right: { no: 3, text: "c" } },
    ])
  })

  it("leaves the other side empty for a pure insert or delete, and keeps both line numbers honest", () => {
    const rows = parseUnified(unifiedDiff(["a", "c"], ["a", "b1", "b2", "c"], 0).text)
    expect(rows.map((r) => `${r.type}:${r.left?.text ?? ""}/${r.right?.text ?? ""}`)).toEqual(["add:/b1", "add:/b2"])
    expect(rows[1].right).toEqual({ no: 3, text: "b2" })

    const removed = parseUnified(unifiedDiff(["a", "b", "c"], ["a", "c"], 0).text)
    expect(removed.map((r) => `${r.type}:${r.left?.text ?? ""}/${r.right?.text ?? ""}`)).toEqual(["del:b/"])
  })

  it("marks where lines were skipped between two hunks", () => {
    const before = ["x", ...Array.from({ length: 20 }, (_, i) => `line ${i}`), "y"]
    const after = ["X", ...Array.from({ length: 20 }, (_, i) => `line ${i}`), "Y"]
    const rows = parseUnified(unifiedDiff(before, after, 1).text)
    const gap = rows.find((r) => r.type === "gap")
    expect(gap).toBeTruthy()
    expect(gap!.skipped).toBe(18) // the 20 unchanged lines minus one of context on each side
    expect(looksLikeDiff(unifiedDiff(before, after, 1).text)).toBe(true)
    expect(looksLikeDiff("show version\nCisco IOS")).toBe(false)
  })

  it("whole-file mode keeps every line, so the view can be scrolled end to end", () => {
    const before = ["a", "b", "c", "d", "e"]
    const after = ["a", "b", "C", "d", "e"]
    const rows = parseUnified(unifiedDiff(before, after, Number.MAX_SAFE_INTEGER).text)
    expect(rows).toHaveLength(5)
    expect(rows.filter((r) => r.type === "same")).toHaveLength(4)
    expect(rows.some((r) => r.type === "gap")).toBe(false)
  })
})

describe("reading a log as command sections", () => {
  it("splits on the markers Config Devices writes, and on nothing else", () => {
    const log = [
      "[Command List]", "show version", "",
      "--- show version ---", "Cisco IOS XE 17.9", "",
      "--- show cdp neighbors detail ---",
      "-------------------------",            // device output, not a header
      "Device ID: SW-ACCESS-01",
      "----- -----              ----------",  // a table rule, not a header
      "--- show run ---", "hostname SW1",
    ].join("\n")
    const sections = splitSections(log)
    expect(sections.map((s) => s.command)).toEqual(["(whole file)", "show version", "show cdp neighbors detail", "show run"])
    expect(sections[0].text).toContain("[Command List]")       // the preamble stays its own section
    expect(sections[2].text).toContain("-------------------------")
    expect(sections[3].text).toBe("hostname SW1")
  })

  it("treats a file with no markers as one section, so any log still compares", () => {
    expect(splitSections("hostname SW1\nvlan 10\n")).toEqual([{ command: "(whole file)", text: "hostname SW1\nvlan 10" }])
    // An empty log has nothing to compare, so everything in the other one reads as "Only in After".
    expect(splitSections("")).toEqual([])
  })

  it("keeps both outputs when a command was run twice", () => {
    const map = byCommand(splitSections("--- show run ---\na\n--- show clock ---\nx\n--- show run ---\nb"))
    expect(map.get("show run")).toBe("a\nb")
  })

  it("skips the commands whose output changes by itself", () => {
    const skip = compileIgnore(DEFAULT_SKIP.join("\n"))
    for (const c of ["show ip route", "show ip route ospf", "show ip arp", "show mac address-table", "show logging", "show clock"]) {
      expect(isSkipped(c, skip), c).toBe(true)
    }
    for (const c of ["show run", "show version", "show cdp nei", "show ip interface brief", "show switch"]) {
      expect(isSkipped(c, skip), c).toBe(false)
    }
  })
})

describe("big files", () => {
  it("anchors on lines that appear once on each side", () => {
    expect(anchorsOf(["a", "x", "b"], ["a", "y", "b"])).toEqual([[0, 0], [2, 2]])
    expect(anchorsOf(["!", "!", "!"], ["!", "!"])).toEqual([]) // nothing unique to anchor on
    // A line that moved backwards cannot be an anchor for both - the longest run in order wins.
    expect(anchorsOf(["a", "b", "c"], ["c", "a", "b"])).toEqual([[0, 1], [1, 2]])
  })

  it("keeps a 60,000-line config readable instead of calling the whole file replaced", () => {
    // Shaped like a real backup: unique interface blocks, one edited line, one inserted block.
    const before: string[] = []
    for (let i = 0; i < 20000; i++) before.push(`interface GigabitEthernet1/0/${i}`, ` description PORT-${i}`, "!")
    const after = [...before]
    after[1] = " description CHANGED"
    after.splice(30000, 0, "interface Vlan999", " ip address 10.9.9.9 255.255.255.0", "!")
    const started = Date.now()
    const { added, removed, text } = unifiedDiff(before, after, 3)
    expect({ added, removed }).toEqual({ added: 4, removed: 1 })
    expect(text).toContain("+ ip address 10.9.9.9 255.255.255.0")
    expect(Date.now() - started).toBeLessThan(5000)
    // The old whole-file fallback would have reported every line of both files.
    expect(added + removed).toBeLessThan(before.length / 100)
  })

  it("still shows one file replaced when there is genuinely nothing in common", () => {
    const a = Array.from({ length: 4000 }, (_, i) => `alpha ${i}`)
    const b = Array.from({ length: 4000 }, (_, i) => `beta ${i}`)
    const ops = diffLines(a, b)
    expect(ops.filter((o) => o.type === "-")).toHaveLength(4000)
    expect(ops.filter((o) => o.type === "+")).toHaveLength(4000)
  })
})

describe("masking secrets", () => {
  it("hides the value but keeps the line, whatever kind of secret it is", () => {
    const cases: [string, string][] = [
      ["enable secret 9 $9$abc123XYZ", "enable secret 9 ********"],
      ["enable password 7 05080F1C22", "enable password 7 ********"],
      [" username admin secret 9 $9$verylonghash", " username admin secret 9 ********"],
      [" password 7 070C285F4D06", " password 7 ********"],
      ["snmp-server community kc$$nMpR0 RO 13", "snmp-server community ******** RO 13"],
      ["tacacs-server key 7 10450A0A251401061C456E", "tacacs-server key 7 ********"],
      [" key 7 00071A150754", " key 7 ********"],
      [" key-string mySharedKey", " key-string ********"],
      [" pre-shared-key 6 abcdef", " pre-shared-key 6 ********"],
      // Straight out of the SML backups - IOS puts the secret in the middle of the line, not at the start.
      [" username network privilege 15 secret 9 $9$KHSeMHoQ2Gsox.$RntVXbIngiL7", " username network privilege 15 secret 9 ********"],
      ["  client 10.8.72.23 server-key 7 132E23302B2D2D1E", "  client 10.8.72.23 server-key 7 ********"],
      [" ip ospf message-digest-key 1 md5 7 070C285F4D06", " ip ospf message-digest-key 1 md5 7 ********"],
      [" snmp-server user adm grp v3 auth sha MyAuthPass priv aes 128 MyPrivPass", " snmp-server user adm grp v3 auth sha ******** priv aes 128 ********"],
    ]
    for (const [line, expected] of cases) expect(maskSecrets(line), line).toBe(expected)
  })

  it("leaves ordinary configuration alone", () => {
    for (const line of ["hostname SW-CORE", " ip address 10.0.0.1 255.255.255.0", "logging host 10.1.1.1",
      " description UPLINK to CORE", "snmp-server location SML-Core-C9300-FL5-01", " key chain OSPF-KEYS",
      " crypto key generate rsa modulus 2048"]) {
      expect(maskSecrets(line), line).toBe(line)
    }
  })

  it("masks the printed diff, not what is compared - a rotated password is still a change", () => {
    const before = ["hostname SW1", "enable secret 9 $9$OLDHASH", "!"]
    const after = ["hostname SW1", "enable secret 9 $9$NEWHASH", "!"]
    const plain = unifiedDiff(before, after, 1)
    const masked = unifiedDiff(before, after, 1, true)
    // Same finding either way: one line replaced.
    expect({ added: masked.added, removed: masked.removed }).toEqual({ added: 1, removed: 1 })
    expect(plain.text).toContain("$9$NEWHASH")
    expect(masked.text).not.toContain("$9$")
    expect(masked.text).toContain("-enable secret 9 ********")
    expect(masked.text).toContain("+enable secret 9 ********")
    // And a secret that did NOT change must not turn into a difference.
    expect(unifiedDiff(before, before, 1, true).text).toBe("")
  })
})
