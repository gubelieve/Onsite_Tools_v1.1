from app.tools import (cdp_inventory, get_inventory, interface_report, lldp_inventory,
                       security_health_check as shc, snmp_inventory, verify_snmp_user)

CDP = """-------------------------
Device ID: SW-ACCESS-01.lab.local
Entry address(es):
  IP address: 10.0.0.2
Platform: cisco C9300-24T,  Capabilities: Switch IGMP
Interface: GigabitEthernet1/0/1,  Port ID (outgoing port): TenGigabitEthernet1/1/1
Holdtime : 150 sec

Version :
Cisco IOS Software [Cupertino], Catalyst L3 Switch Software, Version 17.9.4, RELEASE

Management address(es):
  IP address: 10.0.0.22
-------------------------
Device ID: AP-FLOOR1
Entry address(es):
  IP address: 10.0.1.5
Platform: cisco C9120AXI-S,  Capabilities: Trans-Bridge
Interface: GigabitEthernet1/0/5,  Port ID (outgoing port): GigabitEthernet0
"""

LLDP = """------------------------------------------------
Local Intf: Gi1/0/10
Chassis id: aabb.ccdd.eeff
Port id: 001122334455:P1
System Name: SEP001122334455

Serial number: FCH1234ABCD
Manufacturer: Cisco Systems, Inc.
Model: CP-8841
------------------------------------------------
Local Intf: Te1/1/1
Chassis id: 1111.2222.3333
Port id: Te1/0/1
System Name: CORE-01
"""

CONFIG = """hostname SW-EDGE-01
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
no service dhcp
"""


def test_cdp_parse_blocks():
    rows = cdp_inventory.parse_blocks(CDP, "SW-CORE", "HQ")
    assert len(rows) == 2
    a = rows[0]
    assert a["Device ID"] == "SW-ACCESS-01.lab.local"
    assert a["IP address"] == "10.0.0.22"  # management address wins over entry address
    assert a["Platform"] == "cisco C9300-24T"
    assert a["Interface"] == "GigabitEthernet1/0/1"
    assert a["Port ID"] == "TenGigabitEthernet1/1/1"
    assert a["Site"] == "HQ" and a["Device Switch"] == "SW-CORE"
    assert rows[1]["IP address"] == "10.0.1.5"


def test_cdp_no_neighbours():
    assert cdp_inventory.parse_blocks("Total cdp entries displayed : 0\n", "SW", "X") == []


def test_lldp_parse_blocks():
    rows = lldp_inventory.parse_blocks(LLDP, "SW-CORE", "HQ")
    assert len(rows) == 2
    assert rows[0]["Local Intf"] == "Gi1/0/10"
    assert rows[0]["Serial number"] == "FCH1234ABCD"
    assert rows[0]["Model"] == "CP-8841"
    assert rows[1]["System Name"] == "CORE-01" and rows[1]["Model"] == ""


def test_inventory_parse_ios_xe():
    r = {}
    get_inventory.parse_output(
        "Cisco IOS XE Software, Version 17.09.04a\nCisco IOS Software [Cupertino]",
        'NAME: "c93xx Stack", DESCR: "c93xx Stack"\nPID: C9300-24T  , VID: V02  , SN: FOC1234X0AB\n', r)
    assert r == {"Version": "17.09.04a", "SW Type": "IOS XE", "PID": "C9300-24T", "Serial Number": "FOC1234X0AB"}


def test_inventory_parse_classic_ios():
    r = {}
    get_inventory.parse_output(
        "Cisco IOS Software, C2960X Software (C2960X-UNIVERSALK9-M), Version 15.2(7)E3, RELEASE", "", r)
    assert r["SW Type"] == "IOS" and r["Version"] == "15.2(7)E3"
    assert "PID" not in r


def test_snmp_community_and_users():
    assert verify_snmp_user.parse_snmp_community(
        "snmp-server community public RO\nsnmp-server community secret RW 10\n") == "public; secret"
    result = {}
    verify_snmp_user.parse_snmp_user(
        "User name: monitor\nEngine ID: 8000\nstorage-type: nonvolatile\t active access-list: SNMP-ACL\n"
        "Authentication Protocol: SHA\nPrivacy Protocol: AES128\nGroup-name: v3group\n\n"
        "User name: backup\nEngine ID: 8000\nstorage-type: nonvolatile\t active\n"
        "Authentication Protocol: MD5\nPrivacy Protocol: AES128\nGroup-name: v3group\n", result)
    assert result["SNMPv3 User"] == "monitor; backup"
    assert result["SNMPv3 Active Access-List"] == "SNMP-ACL"
    assert result["Authentication Protocol"] == "SHA; MD5"
    assert result["Privacy Protocol"] == "AES128"
    assert result["Group-name"] == "v3group"


def test_snmp_sysdescr_helpers():
    d = "Cisco IOS Software [Cupertino], Catalyst L3 Switch Software (CAT9K_IOSXE), Version 17.9.4, RELEASE. IOS-XE"
    assert snmp_inventory.extract_version(d) == "17.9.4"
    assert snmp_inventory.extract_image_type(d) == "IOS-XE"
    assert snmp_inventory.extract_image_type("Cisco NX-OS(tm) n9000") == "NX-OS"
    assert snmp_inventory.extract_image_type("something else") == "Unknown"


def test_interface_report_parsing(tmp_path):
    p = tmp_path / "SW-EDGE-01-10.0.0.5_2025-10-21_115548.log"
    p.write_text(CONFIG, encoding="utf-8")
    assert interface_report.hostname_from_filename(str(p)) == "SW-EDGE-01-10.0.0.5"
    by = {r["interface"]: r for r in interface_report.parse_log_file(str(p), "SW-EDGE-01")}
    g = by["GigabitEthernet1/0/1"]
    assert g["switchport_mode"] == "access" and g["description"] == "User port"
    assert g["data vlan"] == "100" and g["voice vlan"] == "200"
    assert g["ip pool data"] == "DATA_POOL" and g["voice pool data"] == "VOICE_POOL"
    assert g["bpdu_enable"] == "spanning-tree bpduguard enable"
    assert g["dot1x authen"] == "DefaultWiredDot1xClosedAuth"
    assert g["device-tracking attach-policy"] == "IPDT_POLICY"
    assert by["TenGigabitEthernet1/1/1"]["switchport_mode"] == "trunk"
    assert by["Vlan100"]["switchport_mode"] == "route port"


def test_shc_filename_info():
    assert shc.extract_info_from_filename("BranchSW-10.1.0.29_2025-10-21_115548.log") == ("10.1.0.29", "BranchSW")
    ip, host = shc.extract_info_from_filename("CWN-B0109-C9500-SP-1.txt")
    assert ip == "Unknown" and host == "CWN_B0109_C9500_SP_1"
    ip, host = shc.extract_info_from_filename("stage_0_10.0.251.62_SS-SW_250819_16.log")
    assert ip == "10.0.251.62" and host.startswith("SS_SW")


def test_shc_search_config_stays_on_one_line():
    assert shc.search_config(CONFIG, "clock timezone") == "GMT 7 0"
    assert shc.search_config(CONFIG, "ntp server") == "10.1.1.1"
    assert shc.search_config(CONFIG, "hostname") == "SW-EDGE-01"
    # commands without arguments report presence and never swallow the following line
    assert shc.search_config(CONFIG, "no ip http server") == "no ip http server"
    assert shc.search_config(CONFIG, "service password-encryption") == "service password-encryption"
    assert shc.search_config(CONFIG, "no ip finger") is None


def test_shc_model_and_version():
    text = ('NAME: "Chassis", DESCR: "Cisco Catalyst 9500"\nPID: C9500-24Y4C , VID: V02\n'
            "Cisco IOS XE Software, Version 17.12.04\n")
    assert shc.extract_model(text) == "C9500-24Y4C"
    assert shc.extract_version(text) == "17.12.04"

