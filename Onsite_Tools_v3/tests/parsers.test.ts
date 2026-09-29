import { describe, expect, it } from "vitest"
import { findCol, parseCsv, toCsv } from "@/lib/csv"
import { dedupeByIp, mapRows, pickDevices, selected } from "@/lib/inventory"
import { detectModel, detectVersion, hostnameFromLogName, imageType, infoFromLogName, parseCdp, parseInterfaces, parseInventory,
  parseLldp, parseSnmpCommunities, parseSnmpUsers, searchConfig, versionFromDescr } from "@/lib/tools/parsers"

const CONFIG = `hostname SW-EDGE-01
!
vlan 100
 name DATA_POOL
!
vlan 200
 name VOICE_POOL
!
interface GigabitEthernet1/0/1
 description User port
 switchport access vlan 100
 switchport mode access
 switchport voice vlan 200
 device-tracking attach-policy IPDT_POLICY
 source template DefaultWiredDot1xClosedAuth
 spanning-tree bpduguard enable
!
interface TenGigabitEthernet1/1/1
 switchport mode trunk
!
interface Vlan100
 ip address 10.0.100.1 255.255.255.0
!
no ip http server
ip http authentication local
clock timezone GMT 7 0
ntp server 10.1.1.1
service password-encryption
`

describe("csv", () => {
  it("reads BOM, CRLF, quoted multi-line cells and trailing empty columns", () => {
    const { fields, rows } = parseCsv('﻿Site,IP_Address,command,,\r\nA,10.0.0.1,"show clock\nshow ver",,\r\n,,,,\r\nB,10.0.0.2,"say ""hi""",,\r\n')
    expect(fields).toEqual(["Site", "IP_Address", "command"])
    expect(rows).toHaveLength(2)
    expect(rows[0].command.split("\n")).toEqual(["show clock", "show ver"])
    expect(rows[1].command).toBe('say "hi"')
    expect(findCol(fields, "ip address", "ip")).toBe("IP_Address")
  })

  it("round-trips through toCsv", () => {
    const text = toCsv(["a", "b"], [{ a: "1,5", b: ["x", "y"], ignored: 1 }])
    expect(parseCsv(text).rows).toEqual([{ a: "1,5", b: "x; y" }])
  })
})

describe("site inventory mapping", () => {
  it("maps the standard list and keeps unknown columns as extras", () => {
    const { devices, skipped } = mapRows(["Site", "IP_Address", "Device_Type", "Description", "command"], [
      { Site: "HQ", IP_Address: "10.0.0.1", Device_Type: "cisco_ios", Description: "CORE", command: "show ver" },
      { Site: "BR", IP_Address: "", Device_Type: "", Description: "no ip", command: "" },
      { Site: "HQ", IP_Address: "10.0.0.1", Device_Type: "cisco_xe", Description: "CORE-NEW", command: "" },
    ])
    expect(skipped).toBe(1)
    expect(devices).toHaveLength(1) // the later duplicate wins
    expect(devices[0]).toMatchObject({ ip: "10.0.0.1", site: "HQ", deviceType: "cisco_xe", description: "CORE-NEW", extra: {} })
  })

  it("understands the IOS-upgrade list and the default site", () => {
    const { devices } = mapRows(["ip_mgmt", "hostname", "zone", "model", "brand"], [{ ip_mgmt: "10.0.251.62", hostname: "SS-SW", zone: "", model: "C9300", brand: "IOS-XE" }], "LAB")
    expect(devices[0]).toMatchObject({ ip: "10.0.251.62", hostname: "SS-SW", site: "LAB", model: "C9300", brand: "IOS-XE" })
    expect(() => mapRows(["Site", "Name"], [{ Site: "x", Name: "y" }])).toThrow(/IP column/)
  })

  it("the device list shown in a form is the same selection the run gets", () => {
    // One rule, used by getDevices (what runs) and previewDevices (what the form lists): first row per IP wins.
    const rows = [
      { ip: "10.0.0.1", list: "a" }, { ip: "10.0.0.2", list: "a" },
      { ip: "10.0.0.1", list: "b" }, { ip: "10.0.0.3", list: "b" },
    ]
    expect(dedupeByIp(rows)).toEqual([{ ip: "10.0.0.1", list: "a" }, { ip: "10.0.0.2", list: "a" }, { ip: "10.0.0.3", list: "b" }])
    expect(dedupeByIp(rows, 2)).toEqual([{ ip: "10.0.0.1", list: "a" }, { ip: "10.0.0.2", list: "a" }])
    expect(dedupeByIp([])).toEqual([])
  })

  it("the tick boxes narrow a run to the devices that were ticked", () => {
    const devices = [{ host: "10.0.0.1" }, { host: "10.0.0.2" }, { host: "10.0.0.3:2222" }]
    // No list of addresses at all (older runs, or nothing ticked by hand) = the whole selection, as before.
    expect(pickDevices(devices, undefined)).toEqual(devices)
    expect(pickDevices(devices, "10.0.0.1")).toEqual(devices)
    expect(pickDevices(devices, ["10.0.0.2", "10.0.0.3:2222"])).toEqual([{ host: "10.0.0.2" }, { host: "10.0.0.3:2222" }])
    // An address that is no longer in the selection simply does not match - it never widens the run.
    expect(pickDevices(devices, ["10.9.9.9"])).toEqual([])
    // Every box cleared means none, and must not quietly fall back to all.
    expect(pickDevices(devices, [])).toEqual([])
  })
})

describe("device output parsers", () => {
  it("inventory", () => {
    expect(parseInventory("Cisco IOS XE Software, Version 17.09.04a", 'NAME: "x"\nPID: C9300-24T  , VID: V02  , SN: FOC1234X0AB\n'))
      .toEqual({ Version: "17.09.04a", "SW Type": "IOS XE", PID: "C9300-24T", "Serial Number": "FOC1234X0AB" })
    expect(parseInventory("Cisco IOS Software, C2960X Software (C2960X-UNIVERSALK9-M), Version 15.2(7)E3, RELEASE", ""))
      .toEqual({ Version: "15.2(7)E3", "SW Type": "IOS" })
  })

  it("cdp prefers the management address and handles no neighbours", () => {
    const out = "-------------------------\nDevice ID: SW-ACCESS-01\nEntry address(es):\n  IP address: 10.0.0.2\nPlatform: cisco C9300-24T,  Capabilities: Switch\n" +
      "Interface: GigabitEthernet1/0/1,  Port ID (outgoing port): TenGigabitEthernet1/1/1\n\nManagement address(es):\n  IP address: 10.0.0.22\n"
    const [r] = parseCdp(out, "CORE", "HQ")
    expect(r).toMatchObject({ "Device Switch": "CORE", "Device ID": "SW-ACCESS-01", "IP address": "10.0.0.22", Platform: "cisco C9300-24T",
      Interface: "GigabitEthernet1/0/1", "Port ID": "TenGigabitEthernet1/1/1", "Device Category": "HQ" })
    expect(parseCdp("Total cdp entries displayed : 0\n", "CORE", "HQ")).toEqual([])
  })

  it("lldp", () => {
    const rows = parseLldp("------------------------------------------------\nLocal Intf: Gi1/0/10\nChassis id: aabb.ccdd.eeff\nPort id: P1\nSystem Name: PHONE\n\nSerial number: FCH1\nModel: CP-8841\n", "CORE", "HQ")
    expect(rows[0]).toMatchObject({ "Local Intf": "Gi1/0/10", "Serial number": "FCH1", Model: "CP-8841", "F/W revision": "" })
  })

  it("snmp communities never swallow the following line", () => {
    expect(parseSnmpCommunities("snmp-server community public RO\nsnmp-server community secret RW 10\n")).toBe("public; secret")
    expect(parseSnmpUsers("User name: monitor\nstorage-type: nonvolatile\t active access-list: SNMP-ACL\nAuthentication Protocol: SHA\nPrivacy Protocol: AES128\nGroup-name: v3group\n\n" +
      "User name: backup\nAuthentication Protocol: MD5\nPrivacy Protocol: AES128\nGroup-name: v3group\n"))
      .toEqual({ "SNMPv3 User": "monitor; backup", "SNMPv3 Active Access-List": "SNMP-ACL", "Authentication Protocol": "SHA; MD5",
        "Privacy Protocol": "AES128", "Group-name": "v3group" })
  })

  it("sysDescr helpers", () => {
    const d = "Cisco IOS Software [Cupertino], Catalyst L3 Switch Software (CAT9K_IOSXE), Version 17.9.4, RELEASE. IOS-XE"
    expect([versionFromDescr(d), imageType(d), imageType("Cisco NX-OS(tm) n9000"), imageType("other")]).toEqual(["17.9.4", "IOS-XE", "NX-OS", "Unknown"])
  })

  it("interface report", () => {
    expect(hostnameFromLogName("SW-EDGE-01-10.0.0.5_2025-10-21_115548.log")).toBe("SW-EDGE-01-10.0.0.5")
    const by = Object.fromEntries(parseInterfaces(CONFIG, "SW-EDGE-01").map((r) => [r.interface, r]))
    expect(by["GigabitEthernet1/0/1"]).toMatchObject({ switchport_mode: "access", description: "User port", "data vlan": "100", "voice vlan": "200",
      "ip pool data": "DATA_POOL", "voice pool data": "VOICE_POOL", bpdu_enable: "spanning-tree bpduguard enable",
      "dot1x authen": "DefaultWiredDot1xClosedAuth", "device-tracking attach-policy": "IPDT_POLICY" })
    expect(by["TenGigabitEthernet1/1/1"].switchport_mode).toBe("trunk")
    expect(by["Vlan100"].switchport_mode).toBe("route port")
  })

  it("security health check", () => {
    expect(infoFromLogName("BranchSW-10.1.0.29_2025-10-21_115548.log")).toEqual({ ip: "10.1.0.29", hostname: "BranchSW" })
    expect(infoFromLogName("CWN-B0109-C9500-SP-1.txt")).toEqual({ ip: "Unknown", hostname: "CWN_B0109_C9500_SP_1" })
    expect(searchConfig(CONFIG, "clock timezone")).toBe("GMT 7 0")
    expect(searchConfig(CONFIG, "no ip http server")).toBe("no ip http server") // present, and the next line is not swallowed
    expect(searchConfig(CONFIG, "no ip finger")).toBe("")
    expect(searchConfig(CONFIG, "hostname")).toBe("SW-EDGE-01")
    const text = 'NAME: "Chassis", DESCR: "Cisco Catalyst 9500"\nPID: C9500-24Y4C , VID: V02\nCisco IOS XE Software, Version 17.12.04\n'
    expect([detectModel(text), detectVersion(text)]).toEqual(["C9500-24Y4C", "17.12.04"])
  })
})

describe("picking several device lists or categories at once", () => {
  it("treats nothing, All, and an empty list as 'everything'", () => {
    for (const v of [undefined, null, "", "All", [], ["All"], ["  "]]) expect(selected(v), JSON.stringify(v)).toBeNull()
  })

  it("keeps what was picked, trims it and drops duplicates", () => {
    expect(selected("LAB")).toEqual(["LAB"])
    expect(selected(["LAB", "arise"])).toEqual(["LAB", "arise"])
    expect(selected([" LAB ", "LAB", "arise"])).toEqual(["LAB", "arise"])
    // "All" alongside real picks is the sentinel from the old single-select value, not a list name.
    expect(selected(["All", "LAB"])).toEqual(["LAB"])
  })
})
