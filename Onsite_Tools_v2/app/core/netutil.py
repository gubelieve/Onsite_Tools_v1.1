"""SSH helpers built on netmiko (same library as v1.1)."""
import re

DEVICE_TYPES = [
    "autodetect", "cisco_ios", "cisco_xe", "cisco_nxos", "cisco_xr", "cisco_asa", "cisco_wlc",
    "cisco_s300", "huawei", "huawei_vrpv8", "hp_procurve", "hp_comware", "aruba_os", "aruba_osswitch",
    "juniper_junos", "arista_eos", "fortinet", "paloalto_panos", "dell_os10", "extreme_exos",
    "linux", "generic",
]


def connect(host, username, password, device_type="autodetect", timeout=20, secret="", port=22,
            read_timeout=60):
    """Open a netmiko connection.

    ``autodetect`` uses netmiko's SSHDetect to guess the platform and falls back
    to ``cisco_ios`` when nothing matches (v1.1 used the generic driver).
    """
    from netmiko import ConnectHandler

    base = {
        "host": host,
        "username": username,
        "password": password,
        "port": int(port or 22),
        "timeout": int(timeout or 20),
        "conn_timeout": int(timeout or 20),
        "auth_timeout": int(timeout or 20),
        "banner_timeout": max(15, int(timeout or 20)),
        "global_delay_factor": 2,
        "fast_cli": False,
        "read_timeout_override": read_timeout,
    }
    if secret:
        base["secret"] = secret
    device_type = (device_type or "autodetect").strip()
    if device_type.lower() == "autodetect":
        guessed = None
        try:
            from netmiko import SSHDetect

            guesser = SSHDetect(device_type="autodetect", **base)
            try:
                guessed = guesser.autodetect()
            finally:
                try:
                    guesser.connection.disconnect()
                except Exception:
                    pass
        except Exception as e:  # authentication or connectivity problems surface here
            msg = str(e)
            if "Authentication" in msg or "authentication" in msg:
                raise
            guessed = None
        device_type = guessed or "cisco_ios"
    conn = ConnectHandler(device_type=device_type, **base)
    conn.detected_type = device_type
    return conn


def prepare(conn):
    """Disable paging and return (prompt, hostname)."""
    prompt = conn.find_prompt()
    try:
        conn.send_command_expect("terminal length 0", expect_string=re.escape(prompt))
    except Exception:
        pass
    hostname = prompt.strip().rstrip("#>").strip()
    return prompt, hostname


def classify_error(exc):
    text = str(exc)
    low = text.lower()
    if "authentication" in low or "auth fail" in low:
        return "Authentication failed."
    if "timed-out" in low or "timed out" in low or "timeout" in low:
        return "Connection timeout"
    if "connection refused" in low or "unreachable" in low or "no route" in low:
        return "Connection Error"
    return "Connection Error"
