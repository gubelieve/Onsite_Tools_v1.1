"""SNMP Inventory - sysName / sysDescr / entPhysical serial & PID over SNMP v2c or v3."""
import asyncio
import re

from ..core import csvutil
from ..core.paths import load_settings

_settings = load_settings()

TOOL = {
    "id": "snmp_inventory",
    "name": "SNMP Inventory",
    "category": "Inventory",
    "order": 33,
    "description": "Query hostname, version, serial number and PID via SNMP (no SSH needed).",
    "fields": [
        {"name": "device_file", "label": "Device list (CSV)", "type": "file", "accept": ".csv,.xlsx", "required": True,
         "template": "device_list_template.csv", "help": "Columns: Site, IP_Address"},
        {"name": "site", "label": "Site", "type": "select", "default": "All",
         "source": {"type": "csv_column", "field": "device_file", "column": "Site", "all_label": "All"}},
        {"name": "version", "label": "SNMP version", "type": "select", "options": ["2c", "3"], "default": "2c",
         "width": "half"},
        {"name": "community", "label": "Community (v2c)", "type": "password", "width": "half",
         "default": _settings.get("snmp_community", ""), "show_if": {"version": "2c"}, "remember": True},
        {"name": "user", "label": "User (v3)", "type": "text", "width": "half", "show_if": {"version": "3"}},
        {"name": "auth", "label": "Auth key (v3)", "type": "password", "width": "half", "show_if": {"version": "3"}},
        {"name": "auth_proto", "label": "Auth protocol", "type": "select", "width": "half", "default": "SHA",
         "options": ["MD5", "SHA", "SHA224", "SHA256", "SHA384", "SHA512"], "show_if": {"version": "3"}},
        {"name": "priv", "label": "Priv key (v3)", "type": "password", "width": "half", "show_if": {"version": "3"}},
        {"name": "priv_proto", "label": "Priv protocol", "type": "select", "width": "half", "default": "AES128",
         "options": ["DES", "3DES", "AES128", "AES192", "AES256"], "show_if": {"version": "3"}},
        {"name": "timeout", "label": "Timeout (s)", "type": "number", "default": 3, "min": 1, "max": 30, "width": "half"},
        {"name": "concurrency", "label": "Concurrency", "type": "number", "default": 50, "min": 1, "max": 200,
         "width": "half"},
    ],
    "columns": ["Hostname", "IP Address", "PID", "Serial Number", "Version", "Image Type", "Status", "sysDescr"],
    "runs": [{"id": "run", "label": "Get SNMP Inventory"}],
}

OIDS = {
    "hostname": "1.3.6.1.2.1.1.5.0",
    "version": "1.3.6.1.2.1.1.1.0",
    "serial": "1.3.6.1.2.1.47.1.1.1.1.11.1",
    "pid": "1.3.6.1.2.1.47.1.1.1.1.13.1",
}


def extract_image_type(desc):
    low = desc.lower()
    if "ios-xe" in low or "ios xe" in low:
        return "IOS-XE"
    if "nx-os" in low:
        return "NX-OS"
    if "ios" in low:
        return "IOS"
    if "junos" in low:
        return "Junos"
    if "eos" in low or "arista" in low:
        return "EOS"
    if "ironware" in low:
        return "IronWare"
    if "vrp" in low or "huawei" in low:
        return "VRP"
    return "Unknown"


def extract_version(desc):
    m = re.search(r"[Vv]ersion\s*([\d.]+[\w.()]*)", desc)
    return m.group(1) if m else desc


def _auth_data(params):
    from pysnmp.hlapi.v3arch.asyncio import CommunityData, UsmUserData
    from pysnmp.hlapi.v3arch.asyncio import auth as A

    if params.get("version") == "3":
        auth_map = {"MD5": A.USM_AUTH_HMAC96_MD5, "SHA": A.USM_AUTH_HMAC96_SHA, "SHA224": A.USM_AUTH_HMAC128_SHA224,
                    "SHA256": A.USM_AUTH_HMAC192_SHA256, "SHA384": A.USM_AUTH_HMAC256_SHA384,
                    "SHA512": A.USM_AUTH_HMAC384_SHA512}
        priv_map = {"DES": A.USM_PRIV_CBC56_DES, "3DES": A.USM_PRIV_CBC168_3DES, "AES128": A.USM_PRIV_CFB128_AES,
                    "AES192": A.USM_PRIV_CFB192_AES, "AES256": A.USM_PRIV_CFB256_AES}
        kwargs = {}
        if params.get("auth"):
            kwargs["authKey"] = params["auth"]
            kwargs["authProtocol"] = auth_map.get(params.get("auth_proto", "SHA"), A.USM_AUTH_HMAC96_SHA)
        if params.get("priv"):
            kwargs["privKey"] = params["priv"]
            kwargs["privProtocol"] = priv_map.get(params.get("priv_proto", "AES128"), A.USM_PRIV_CFB128_AES)
        return UsmUserData(params.get("user", ""), **kwargs)
    return CommunityData(params.get("community", ""), mpModel=1)


async def _query(ip, params, timeout):
    from pysnmp.hlapi.v3arch.asyncio import (ContextData, ObjectIdentity, ObjectType, SnmpEngine, UdpTransportTarget,
                                             get_cmd)

    engine = SnmpEngine()
    result = {"ip": ip}
    try:
        target = await UdpTransportTarget.create((ip, 161), timeout=timeout, retries=1)
        for key, oid in OIDS.items():
            try:
                err_ind, err_stat, err_idx, var_binds = await get_cmd(engine, _auth_data(params), target, ContextData(),
                                                                      ObjectType(ObjectIdentity(oid)))
                if err_ind:
                    result[key] = f"SNMP Error: {err_ind}"
                elif err_stat:
                    result[key] = f"SNMP Error: {err_stat.prettyPrint()}"
                else:
                    result[key] = str(var_binds[0][1]) if var_binds else ""
            except Exception as e:
                result[key] = f"SNMP Error: {e}"
    finally:
        try:
            engine.close_dispatcher()
        except Exception:
            pass
    return result


def run(ctx, params):
    devices = csvutil.load_devices(params.get("device_file"), params.get("site", "All"))
    if not devices:
        ctx.warn("No devices found for the selected site.")
        return
    if params.get("version") == "3" and not params.get("user"):
        ctx.error("Please enter the SNMPv3 user name.")
        return
    if params.get("version") != "3" and not params.get("community"):
        ctx.error("Please enter the SNMP community.")
        return
    ctx.set_columns(TOOL["columns"], TOOL["columns"] + ["Site"])
    keys = {d["host"]: ctx.add_row({"Hostname": "", "IP Address": d["host"], "PID": "", "Serial Number": "", "Version": "",
                                    "Image Type": "", "Status": "Pending...", "sysDescr": "", "Site": d["site"]})
            for d in devices}
    ctx.progress(0, len(devices))
    timeout = float(params.get("timeout") or 3)
    sem_n = max(1, int(params.get("concurrency") or 50))
    ok = {"n": 0}

    async def main():
        sem = asyncio.Semaphore(sem_n)

        async def one(d):
            async with sem:
                if ctx.stop_requested:
                    ctx.update_row(keys[d["host"]], Status="Stopped by user")
                    ctx.step()
                    return
                try:
                    r = await _query(d["host"], params, timeout)
                    errs = [v for v in r.values() if isinstance(v, str) and v.startswith("SNMP Error")]
                    desc = r.get("version", "")
                    status = "Success" if not errs else ("Failed" if len(errs) == 4 else "Partial")
                    if status != "Failed":
                        ok["n"] += 1
                    ctx.update_row(keys[d["host"]], Hostname=r.get("hostname", ""), PID=r.get("pid", ""),
                                   Version=extract_version(desc) if not desc.startswith("SNMP Error") else desc,
                                   sysDescr=desc, Status=status if not errs else f"{status}: {errs[0]}",
                                   **{"Serial Number": r.get("serial", ""), "Image Type": extract_image_type(desc)})
                except Exception as e:
                    ctx.log(f"SNMP worker error for {d['host']}: {e}", "ERROR")
                    ctx.update_row(keys[d["host"]], Status=f"Error: {e}")
                finally:
                    ctx.step()

        await asyncio.gather(*(one(d) for d in devices))

    asyncio.run(main())
    ctx.summary(f"Total {ok['n']}/{len(devices)}")
    ctx.info("SNMP inventory finished.")
