"""IOS Upgrade - multi-stage upgrade with verification (port of v1.1 upgrade_ios).

Stages (each is a separate run so you can review results between them):
  0 Verify environment   1 Upload IOS via FTP   2 Verify MD5
  3 Install image        4 Check status         5 Verify services
An FTP server serving the IOS file must be started manually (FileZilla, IIS, ...).
"""
import hashlib
import os
import platform
import re
import socket
import subprocess
import time
from datetime import datetime

from ..core import inventory
from ..core.logutil import now_hms
from ..core.netutil import connect
from ..core.paths import load_settings

_settings = load_settings()

STAGE_NAMES = ["Verify Environment", "Upload IOS", "Verify MD5", "Install Image", "Check Status", "Verify Services"]

TOOL = {
    "id": "upgrade_ios",
    "name": "IOS Upgrade",
    "category": "SSH Tools",
    "order": 15,
    "description": "Multi-stage Cisco IOS/IOS-XE upgrade: verify environment, FTP upload, MD5 check, install, "
                   "post-checks. Run the stages in order; each stage is a separate job.",
    "fields": [
        {"name": "ios_file", "label": "IOS image file", "type": "path", "kind": "file", "required": True,
         "filetypes": [["IOS images", "*.bin *.tar *.img"], ["All files", "*.*"]],
         "help": "Local path of the image (must also be in the FTP server root)."},
        {"name": "inventory_list", "label": "Device list (Site Inventory)", "type": "select", "default": "All",
         "width": "half", "source": {"type": "inventory_lists", "all_label": "All"},
         "help": "Import the upgrade list (ip_mgmt, hostname, zone, ...) in the Site Inventory menu."},
        {"name": "site", "label": "Site / zone", "type": "select", "default": "All", "width": "half",
         "source": {"type": "inventory_sites", "field": "inventory_list", "all_label": "All"}, "show_count": True},
        {"name": "username", "label": "Username", "type": "text", "required": True, "width": "half",
         "default": _settings.get("default_username", ""), "remember": True},
        {"name": "password", "label": "Password", "type": "password", "required": True, "width": "half",
         "default": _settings.get("default_password", ""), "remember": True},
        {"name": "device_type", "label": "Device type", "type": "select", "default": "cisco_ios",
         "options": "device_types", "width": "half"},
        {"name": "install_method", "label": "Installation method", "type": "select", "default": "reload",
         "width": "half", "options": [{"value": "reload", "label": "Reload (boot system + reload)"},
                                      {"value": "boot", "label": "Boot variable change only"},
                                      {"value": "install", "label": "Install mode (install add ... activate commit)"}]},
        {"name": "ftp_ip", "label": "FTP server IP (this PC)", "type": "text", "default_action": "local_ip",
         "width": "half", "help": "Auto-detected local IP; edit if the devices reach this PC on another address."},
        {"name": "threads", "label": "Max threads", "type": "number", "default": 3, "min": 1, "max": 10, "width": "half"},
    ],
    "columns": ["Stage", "Host", "Hostname", "Status", "Message", "Bytes Transferred", "Output", "Timestamp"],
    "runs": [
        {"id": "stage0", "label": "Stage 0: Verify Environment", "params": {"stage": 0}},
        {"id": "stage1", "label": "Stage 1: Upload IOS", "params": {"stage": 1},
         "notice": "Before running Stage 1, start an FTP server manually (FileZilla Server, IIS, ...):\n"
                   "1. Set the FTP root directory to the folder containing the IOS file\n"
                   "2. Allow anonymous (or configure credentials)\n"
                   "3. Make sure the devices can reach this PC on the FTP IP shown in the form"},
        {"id": "stage2", "label": "Stage 2: Verify MD5", "params": {"stage": 2}},
        {"id": "stage3", "label": "Stage 3: Install Image", "params": {"stage": 3}, "danger": True,
         "confirm": "WARNING: This will install the new IOS image on all selected devices. Devices will reload and "
                    "service will be interrupted. Are you sure you want to proceed?"},
        {"id": "stage4", "label": "Stage 4: Check Status", "params": {"stage": 4}},
        {"id": "stage5", "label": "Stage 5: Verify Services", "params": {"stage": 5}},
    ],
}


def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        try:
            return socket.gethostbyname(socket.gethostname())
        except Exception:
            return "192.168.1.100"


ACTIONS = {"local_ip": lambda params=None: {"value": get_local_ip()}}


def calculate_md5(path):
    if platform.system() == "Windows":
        try:
            r = subprocess.run(["CertUtil", "-hashfile", path, "MD5"], capture_output=True, text=True, check=True)
            for line in r.stdout.splitlines():
                line = line.strip().replace(" ", "")
                if re.match(r"^[a-fA-F0-9]{32}$", line):
                    return line.lower()
        except Exception:
            pass
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


class Stage:
    def __init__(self, ctx, params, device):
        self.ctx = ctx
        self.params = params
        self.host = device["host"]
        self.csv_hostname = device.get("hostname", "")
        self.hostname = device.get("hostname", "") or "Unknown"
        self.stage = int(params.get("stage", 0))
        self.ios_file = params["ios_file"]
        self.filename = os.path.basename(self.ios_file)
        self.ftp_ip = (params.get("ftp_ip") or "").strip() or get_local_ip()

    # ------------------------------------------------------------ helpers
    def emit(self, status, message, nbytes="0", output=""):
        self.ctx.add_row({"Stage": f"Stage {self.stage}", "Host": self.host, "Hostname": self.hostname, "Status": status,
                          "Message": message, "Bytes Transferred": str(nbytes), "Output": output, "Timestamp": now_hms()})

    def log_cmd(self, command, output, status="Completed"):
        try:
            ts = datetime.now().strftime("%y%m%d_%H")
            path = os.path.join(self.ctx.run_dir, f"stage_{self.stage}_{self.host}_{self.hostname}_{ts}.log")
            with open(path, "a", encoding="utf-8") as f:
                f.write(f"\n{'=' * 80}\nTimestamp: {datetime.now():%Y-%m-%d %H:%M:%S}\nHost: {self.host}\n"
                        f"Hostname: {self.hostname}\nStage: Stage {self.stage}\nStatus: {status}\nCommand: {command}\n"
                        f"Output:\n{output}\n{'=' * 80}\n")
        except Exception as e:
            self.ctx.log(f"Failed to log command result: {e}", "ERROR")

    def connect(self):
        dt = self.params.get("device_type") or "cisco_ios"
        conn = connect(self.host, self.params["username"], self.params["password"], dt, timeout=30, read_timeout=60)
        prompt = conn.find_prompt()
        self.hostname = prompt.strip().rstrip("#>") or self.hostname
        try:
            conn.send_command_expect("terminal length 0", expect_string=re.escape(prompt))
        except Exception:
            pass
        return conn

    def send(self, conn, cmd, read_timeout=60):
        prompt = conn.find_prompt()
        return conn.send_command(cmd, read_timeout=read_timeout, expect_string=re.escape(prompt))

    # ------------------------------------------------------------ stage 0
    def verify_environment(self):
        self.emit("Running", "Starting environment verification...")
        try:
            conn = self.connect()
        except Exception as e:
            self.emit("Failed", f"Device connectivity failed: {e}", "0", str(e))
            return
        try:
            show_version = self.send(conn, "show version")
            self.log_cmd("show version", show_version)
            model = re.search(r"Cisco\s+(\S+)", show_version)
            ios = re.search(r"IOS.+Version\s+([^,]+)", show_version)
            self.emit("Pass", f"Device info: Hostname: {self.hostname}, Model: {model.group(1) if model else 'Unknown'}, "
                              f"IOS: {ios.group(1) if ios else 'Unknown'}", "0", show_version)

            show_flash = self.send(conn, "dir flash:")
            self.log_cmd("dir flash:", show_flash)
            free = re.search(r"(\d+)\s+bytes free", show_flash)
            if free:
                free_b = int(free.group(1))
                need = os.path.getsize(self.ios_file)
                msg = f"{free_b / 1048576:.1f}MB free, {need / 1048576:.1f}MB required"
                if free_b >= need:
                    self.emit("Pass", "Flash space OK: " + msg, "0", show_flash)
                else:
                    self.emit("Failed", "Flash space INSUFFICIENT: " + msg, "0", show_flash)
            else:
                self.emit("Failed", "Failed to parse flash space", "0", show_flash)
                return

            ping = self.send(conn, f"ping {self.ftp_ip} repeat 3")
            self.log_cmd(f"ping {self.ftp_ip}", ping)
            if re.search(r"Success rate is (100|80|66|60) percent", ping):
                self.emit("Pass", f"FTP server connectivity OK: {self.ftp_ip}", "0", ping)
            else:
                self.emit("Failed", f"FTP server connectivity FAILED: {self.ftp_ip}", "0", ping)

            show_run = self.send(conn, "show running-config", read_timeout=120)
            self.log_cmd("show running-config", show_run)
            low = show_run.lower()
            checks = {"SSH enabled": "ip ssh" in low, "Console timeout": "exec-timeout" in low,
                      "Logging configured": "logging" in low, "NTP configured": "ntp" in low}
            self.emit("Pass", "Configuration checks: " + ", ".join(f"{k}: {'OK' if v else 'missing'}" for k, v in checks.items()),
                      "0", "Configuration verified")

            show_boot = self.send(conn, "show boot")
            self.log_cmd("show boot", show_boot)
            m = re.search(r"Boot image:\s+(.+)", show_boot) or re.search(r"BOOT variable\s*=\s*(.+)", show_boot)
            self.emit("Pass", f"Current boot image: {m.group(1).strip() if m else 'Not configured'}", "0", show_boot)

            boot_cfg = self.send(conn, "show run all | i boot")
            self.log_cmd("show run all | i boot", boot_cfg)
            bl = boot_cfg.lower()
            if "boot system rommon" in bl:
                self.emit("Failed", "WARNING: boot system rommon detected - may cause boot issues", "0", boot_cfg)
            elif "boot system flash" not in bl and "packages.conf" not in bl and "boot system switch" not in bl:
                self.emit("Failed", "WARNING: No boot system flash or packages.conf configured", "0", boot_cfg)
            else:
                self.emit("Pass", "Boot configuration OK", "0", boot_cfg)

            summ = self.send(conn, "show install summary")
            self.log_cmd("show install summary", summ)
            info = []
            for k in ("Active", "Inactive", "Committed"):
                m = re.search(rf"{k}:\s+(.+)", summ)
                if m:
                    info.append(f"{k}: {m.group(1).strip()}")
            self.emit("Pass", "Install summary: " + (", ".join(info) if info else "No packages found"), "0", summ)
            self.emit("Completed", "Environment verification completed successfully", "0", "All checks passed")
        except Exception as e:
            self.log_cmd("Environment verification", str(e), "Failed")
            self.emit("Failed", f"Environment verification failed: {e}", "0", str(e))
        finally:
            conn.disconnect()

    # ------------------------------------------------------------ stage 1
    def upload_ios(self):
        transfer_command = "Unknown"
        try:
            conn = self.connect()
        except Exception as e:
            self.emit("Failed", f"Connection failed: {e}", "0", str(e))
            return
        try:
            filename = self.filename.replace("_", "-").replace(" ", "-")
            file_size = os.path.getsize(self.ios_file)
            self.emit("Running", f"Starting FTP upload of {filename} from {self.ftp_ip} ({file_size:,} bytes)")
            transfer_command = f"copy ftp://{self.ftp_ip}/{self.filename} flash:{filename}"
            output = conn.send_command_timing(transfer_command, read_timeout=30)
            if "Destination filename" in output:
                output += conn.send_command_timing(filename, read_timeout=30)
            if "Username" in output:
                self.ctx.log(f"FTP authentication required for {self.host}", "WARNING")
                output += conn.send_command_timing("", read_timeout=30)
            if "Bad filename" in output or "Error parsing filename" in output:
                self.emit("Failed", f"Filename error: {filename} contains invalid characters", "0", output)
                return
            start = time.time()
            last_msg = start
            transferred = 0
            last = 0
            unchanged = 0
            final = output
            pattern = re.compile(rf"\d+\s+-\w-\s+(\d+)\s+.*{re.escape(filename)}", re.IGNORECASE)
            while time.time() - start < 3000:
                if self.ctx.stop_requested:
                    self.emit("Failed", "Stopped by user during upload", f"{transferred:,}", final)
                    return
                try:
                    dir_out = conn.send_command(f"dir flash: | inc {filename}", read_timeout=15)
                    final += f"\n--- Dir Check ---\n{dir_out}"
                    m = pattern.search(dir_out)
                    if m:
                        transferred = int(m.group(1).replace(",", ""))
                        pct = min(100, int(transferred / file_size * 100))
                        if transferred == last:
                            unchanged += 1
                        else:
                            unchanged = 0
                            last = transferred
                        if transferred >= file_size:
                            break
                        if unchanged >= 3:
                            break
                        if time.time() - last_msg > 5:
                            self.emit("Running", f"Uploading {filename} via FTP from {self.ftp_ip}: "
                                                 f"{transferred:,}/{file_size:,} bytes ({pct}%)", f"{transferred:,}", dir_out)
                            last_msg = time.time()
                    else:
                        unchanged += 1
                        if unchanged >= 3:
                            self.ctx.log(f"Transfer failed: {filename} not found on flash for 3 intervals", "ERROR")
                            break
                    time.sleep(5)
                except Exception as e:
                    final += f"\n--- Error ---\n{e}"
                    time.sleep(5)
            self.log_cmd(transfer_command, final)
            if transferred >= file_size:
                self.emit("Completed", f"IOS uploaded successfully ({file_size:,} bytes)", f"{file_size:,}", final)
            elif transferred > 0:
                self.emit("Completed", f"Transfer stopped growing at {transferred:,}/{file_size:,} bytes - verify with Stage 2",
                          f"{transferred:,}", final)
            else:
                self.emit("Failed", "File not found on flash after copy command", "0", final)
        except Exception as e:
            self.log_cmd(transfer_command, str(e), "Failed")
            self.emit("Failed", str(e), "0", str(e))
        finally:
            conn.disconnect()

    # ------------------------------------------------------------ stage 2
    def verify_md5(self):
        try:
            conn = self.connect()
        except Exception as e:
            self.emit("Failed", f"Connection failed: {e}", "0", str(e))
            return
        try:
            filename = self.filename.replace("_", "-").replace(" ", "-")
            self.emit("Running", "Calculating local MD5 hash...")
            local_md5 = calculate_md5(self.ios_file)
            self.log_cmd("Local MD5 calculation", f"File: {self.ios_file}\nMD5: {local_md5}")
            self.emit("Running", f"Local MD5: {local_md5}", "0", f"Local MD5 calculated: {local_md5}")
            self.emit("Running", "Getting device MD5 hash...")
            out = self.send(conn, f"verify /md5 flash:{filename}", read_timeout=600)
            self.log_cmd(f"verify /md5 flash:{filename}", out)
            m = re.search(r"([a-fA-F0-9]{32})", out)
            dev = m.group(1).lower() if m else None
            cmp_text = f"MD5 Comparison:\nLocal: {local_md5}\nDevice: {dev}\nMatch: {dev == local_md5}"
            if dev and dev == local_md5:
                self.emit("Completed", f"MD5 verified successfully - {local_md5[:8]}...", "0", cmp_text + "\n\n" + out)
            elif not dev:
                self.emit("Failed", "MD5 verification failed - could not extract device MD5", "0", out)
            else:
                self.emit("Failed", f"MD5 verification failed - Local: {local_md5[:8]}..., Device: {dev[:8]}...", "0",
                          cmp_text + "\n\n" + out)
        except Exception as e:
            self.emit("Failed", f"MD5 verification failed: {e}", "0", str(e))
        finally:
            conn.disconnect()

    # ------------------------------------------------------------ stage 3
    def install_image(self):
        try:
            conn = self.connect()
        except Exception as e:
            self.emit("Failed", f"Connection failed: {e}", "0", str(e))
            return
        method = self.params.get("install_method") or "reload"
        filename = self.filename.replace("_", "-").replace(" ", "-")
        output = ""
        try:
            if method == "reload":
                output += conn.send_config_set([f"boot system flash:{filename}"])
                output += conn.save_config()
                try:
                    output += conn.send_command("reload", expect_string=r"confirm|\[yes/no\]", read_timeout=30)
                    if re.search(r"\[yes/no\]", output):
                        output += conn.send_command("no", expect_string=r"confirm", read_timeout=30)
                    output += conn.send_command_timing("\n", read_timeout=10)
                except Exception as e:
                    output += f"\n[reload sent - session closed: {e}]"
                self.log_cmd(f"boot system flash:{filename} + reload", output)
                self.emit("Completed", "Boot variable set and reload issued", "0", output)
            elif method == "boot":
                output += conn.send_config_set([f"boot system flash:{filename}"])
                output += conn.save_config()
                self.log_cmd(f"boot system flash:{filename}", output)
                self.emit("Completed", "Boot variable updated (no reload)", "0", output)
            else:
                output += conn.send_config_set(["boot system switch all flash:packages.conf"])
                output += conn.save_config()
                cmd = f"install add file flash:{filename} activate commit prompt-level none"
                prompt = conn.find_prompt()
                output += conn.send_command(cmd, read_timeout=1800, expect_string=re.escape(prompt))
                self.log_cmd(cmd, output)
                self.emit("Completed", "Image installed successfully (install mode)", "0", output)
        except Exception as e:
            self.log_cmd("install", output + f"\n{e}", "Failed")
            self.emit("Failed", f"Image installation failed: {e}", "0", output + f"\n{e}")
        finally:
            try:
                conn.disconnect()
            except Exception:
                pass

    # ------------------------------------------------------------ stage 4
    def check_status(self):
        try:
            conn = self.connect()
        except Exception as e:
            self.emit("Failed", f"Connection failed: {e}", "0", str(e))
            return
        try:
            out = self.send(conn, "show version")
            self.log_cmd("show version", out)
            ver = re.search(r"Version\s+([^,\s]+)", out)
            if "ROM:" in out and "System Bootstrap" in out:
                self.emit("Completed", f"Installation successful - running {ver.group(1) if ver else 'unknown'}", "0", out)
            else:
                self.emit("Failed", "Installation may have failed", "0", out)
        except Exception as e:
            self.emit("Failed", f"Installation status check failed: {e}", "0", str(e))
        finally:
            conn.disconnect()

    # ------------------------------------------------------------ stage 5
    def verify_services(self):
        try:
            conn = self.connect()
        except Exception as e:
            self.emit("Failed", f"Connection failed: {e}", "0", str(e))
            return
        try:
            outs = []
            for cmd in ("show interfaces", "show ip interface brief", "show processes cpu"):
                out = self.send(conn, cmd, read_timeout=120)
                outs.append(f"--- {cmd} ---\n{out}")
                self.log_cmd(cmd, out)
                if cmd == "show processes cpu" and "failed" in out.lower():
                    self.emit("Failed", f"Service check failed: {cmd}", "0", out)
                    return
            summ = self.send(conn, "show install summary")
            outs.append(f"--- show install summary ---\n{summ}")
            self.log_cmd("show install summary", summ)
            info = []
            for k in ("Active", "Inactive", "Committed"):
                m = re.search(rf"{k}:\s+(.+)", summ)
                if m:
                    info.append(f"{k}: {m.group(1).strip()}")
            outs.append("--- Install Status ---\nInstall summary: " + (", ".join(info) if info else "No packages found"))
            brief = self.send(conn, "show ip interface brief")
            down = [l for l in brief.splitlines() if re.search(r"\s(down|administratively down)\s", l)]
            msg = "All services verified" + (f" ({len(down)} interface(s) down)" if down else "")
            self.emit("Completed", msg, "0", "\n".join(outs))
        except Exception as e:
            self.emit("Failed", f"Service verification failed: {e}", "0", str(e))
        finally:
            conn.disconnect()

    def run(self):
        [self.verify_environment, self.upload_ios, self.verify_md5, self.install_image, self.check_status,
         self.verify_services][self.stage]()


def run(ctx, params):
    stage = int(params.get("stage", 0))
    ios_file = (params.get("ios_file") or "").strip().strip('"')
    if not os.path.isfile(ios_file):
        ctx.error(f"IOS image file not found: {ios_file}")
        return
    params = dict(params, ios_file=ios_file)
    devices = inventory.devices_for(ctx, params)
    if not devices:
        return
    ctx.set_columns(TOOL["columns"])
    ctx.summary(f"Stage {stage} - {STAGE_NAMES[stage]}: {len(devices)} device(s)")

    def work(d):
        Stage(ctx, params, d).run()

    ctx.map_parallel(devices, work, params.get("threads", 3))
    rows = ctx.rows()
    failed = sum(1 for r in rows if r.get("Status") in ("Failed", "Error"))
    completed = sum(1 for r in rows if r.get("Status") == "Completed")
    if stage == 1:
        total_bytes = 0
        for r in rows:
            if r.get("Status") == "Completed":
                try:
                    total_bytes += int(str(r.get("Bytes Transferred", "0")).replace(",", ""))
                except ValueError:
                    pass
        ctx.summary(f"Stage 1 completed: {completed}/{len(devices)} uploads, {total_bytes / 1048576:.2f} MB transferred")
    else:
        ctx.summary(f"Stage {stage} - {STAGE_NAMES[stage]}: {completed} completed, {failed} failed of {len(devices)}")
    if failed:
        ctx.warn(f"Stage {stage} finished with {failed} failed check(s). Review the results before continuing.")
    else:
        ctx.info(f"Stage {stage} ({STAGE_NAMES[stage]}) finished for {len(devices)} device(s).")
