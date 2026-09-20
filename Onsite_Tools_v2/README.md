# Onsite Tools v2 – Web Edition

เวอร์ชัน Web App ของ **Onsite_Tools_v1.1** (PySide6) – ฟังก์ชันเดิมทั้งหมดถูกย้ายมาเป็น
Web Application (Python FastAPI + HTML/JS ไม่ต้อง build) ใช้ library เดิมในการคุยกับอุปกรณ์
(**netmiko / paramiko / pysnmp / requests / selenium**) ผลลัพธ์จึงเหมือน v1.1

## เริ่มใช้งาน (Copy folder ไปวางแล้ว run ได้เลย)

1. ต้องมี **Python 3.9+** ติดตั้งในเครื่อง (ติ๊ก *Add python.exe to PATH* ตอนติดตั้ง)
2. Copy โฟลเดอร์ `Onsite_Tools_v2` ไปไว้ที่ไหนก็ได้
3. ดับเบิลคลิก **`run.bat`** (Linux/macOS ใช้ `./run.sh`)
   * ครั้งแรกจะสร้าง `.venv` และติดตั้ง `requirements.txt` ให้เอง (ต้องต่อ internet ครั้งแรก, ใช้เวลา 2-5 นาที)
   * ครั้งต่อไปเปิดได้ทันที
4. Browser จะเปิด **http://127.0.0.1:8088** ให้อัตโนมัติ

ถ้าเครื่องปลายทางไม่มี internet: run `run.bat` ในเครื่องที่มี internet หนึ่งครั้งก่อน แล้ว copy ทั้งโฟลเดอร์
(รวม `.venv`) ไปด้วย – ใช้ได้ทันทีตราบใดที่เป็น Windows + Python เวอร์ชันเดียวกัน

ให้เครื่องอื่นใน LAN เปิดใช้ด้วย: run **`run_lan.bat`** แล้วเข้า `http://<IP เครื่องนี้>:8088`

## วิธีใช้

1. เปิดเมนู **📋 Site Inventory** (บนสุดของเมนูซ้าย) แล้ว **Import** ไฟล์รายการอุปกรณ์ (CSV / XLSX) ครั้งเดียว
   – ข้อมูลถูกเก็บถาวรที่ `data/site_inventory.json` ไม่ต้อง browse ไฟล์ซ้ำทุกครั้ง
2. เลือกเครื่องมือจากเมนูซ้าย แล้วเลือก **Device list** และ **Site** จาก Site Inventory (ระบบแสดงจำนวนอุปกรณ์ที่เลือก)
3. ใส่ Username / Password เลือก Device type, Max threads
4. กด **Run** – ผลลัพธ์แสดงสดในตาราง กด **View** ดู output เต็ม, **Stop** หยุด, **Export CSV** ส่งออก
5. ติ๊ก **Remember credentials** ที่มุมซ้ายล่าง ถ้าต้องการให้จำ user/password ไว้ใน browser เครื่องนี้
6. ค่า default (username, community ฯลฯ) ตั้งได้ใน `settings.json`

Log ของทุกการ run อยู่ที่ `logs/<tool>/<วันเวลา>/` เหมือน v1.1, ไฟล์ export อยู่ที่ `exports/`

## Site Inventory

| ความสามารถ | รายละเอียด |
|------------|------------|
| Import | CSV / XLSX ต้องมีคอลัมน์ IP (`IP_Address` / `ip_mgmt` / `ip` / `managementIpAddress`) คอลัมน์อื่นที่รู้จัก: `Site` หรือ `zone`, `Hostname`, `Device_Type`, `Model`, `Brand`, `Description` – คอลัมน์อื่น ๆ (เช่น `command`) ถูกเก็บไว้ด้วย |
| List name | แต่ละไฟล์ที่ import เป็นหนึ่ง **list** (ค่าเริ่มต้น = ชื่อไฟล์) ใช้แทนการ "เลือกไฟล์" แบบเดิม |
| Import mode | **Merge** = เพิ่มใหม่ + update IP ที่ซ้ำใน list เดิม, **Replace** = ให้ list เหลือเท่ากับไฟล์นี้ |
| จัดการ | ค้นหา / กรองตาม list และ site, เพิ่ม-แก้ไข-ลบอุปกรณ์ทีละตัว, ลบทั้ง list, Export CSV |
| ประวัติ | เก็บประวัติการ import (ไฟล์, เวลา, added / updated / skipped / removed) |

เครื่องมือที่ดึงอุปกรณ์จาก Site Inventory: Config Devices, IOS Upgrade, Client Status Checker, Get / CDP / LLDP / SNMP
Inventory, Verify SNMP User, DNAC Port Assignment เมื่อเลือก list = All ระบบจะตัด IP ที่ซ้ำกันข้าม list ให้อัตโนมัติ

ไฟล์ที่ **ไม่ใช่รายการอุปกรณ์** ยังคง upload ในหน้าเครื่องมือเหมือนเดิม: URL list (DNAC REST API), site list (SD-WAN API),
capture list (Capture DNAC) และ log files (Interface Report / Security Health Check)

> `data/` มี IP ของลูกค้า จึงอยู่ใน `.gitignore` – ถ้า copy โฟลเดอร์ไปเครื่องอื่นให้ copy `data/` ไปด้วยเพื่อพก inventory ไป

## เครื่องมือที่มี

| Tool | v1.1 module | หมายเหตุ |
|------|-------------|----------|
| Config Devices | config_devices + config_devices_v2 | Verify/Config mode, คอลัมน์ผลลัพธ์ต่อคำสั่ง, ใช้คอลัมน์ `command` ต่ออุปกรณ์จาก Site Inventory ได้, Generate Report (ต้องติดตั้ง ydata-profiling) |
| IOS Upgrade | upgrade_ios | 6 stage, FTP server ต้องเปิดเอง, ตรวจ MD5, install/reload |
| Client Status Checker | client_status_checker | หา MAC ใน mac table / ARP |
| Get Inventory | get_inventory | show version / show inventory |
| CDP Inventory | cdp_inventory | show cdp neighbor detail |
| LLDP Inventory | lldp_inventory | show lldp neighbor detail |
| SNMP Inventory | snmp_inventory | SNMP v2c / v3 (เลือก auth/priv protocol ได้) |
| Verify SNMP User | verify_snmp_user | community + snmp user |
| Interface Report | interface_report | parse running-config เป็นรายงาน interface |
| Security Health Check | security_health_check | เทียบ log กับ `templates/shc_template.csv` |
| DNAC REST API | dnac_rest_api | GET endpoint จาก CSV, บันทึก JSON ที่ `exports/dnac_output/` |
| DNAC Port Assignment | dnac_port_assignment | network-device + SDA port assignments |
| SD-WAN API (Site List) | sd_wan_api | POST site list ไป vManage แล้ว verify |
| Capture DNAC | capture_dnac | Selenium screenshot (ต้องมี Chrome) |

## ความแตกต่างจาก v1.1 ที่ควรรู้

* **รายการอุปกรณ์** – import ครั้งเดียวที่เมนู Site Inventory แล้วทุกเครื่องมือเลือกจาก list / site (ไม่ต้อง browse CSV ทุกครั้ง)
* **ไฟล์อื่น ๆ** – upload ผ่าน browser ไปเก็บใน `uploads/`; ช่องที่ต้องการ path ในเครื่อง
  (IOS image, log folder, template) พิมพ์ path ได้เลยหรือกด **Browse…** (เปิด dialog ของ Windows บนเครื่องที่ run server)
* **Device type** – เลือกได้ในฟอร์ม (default `autodetect`) และค่า `Device_Type` ที่เก็บใน Site Inventory จะ override
* **รหัสผ่านที่เคย hardcode** (`sdaadmin` ฯลฯ) ถูกเอาออก – ใส่เองหรือตั้งใน `settings.json` / ติ๊ก Remember credentials
* **SSL** – เครื่องมือ DNAC / vManage มีช่อง *Verify SSL certificate* (ปิดไว้เป็นค่าเริ่มต้น เพราะส่วนใหญ่เป็น self-signed)
* แต่ละ stage ของ IOS Upgrade เป็นคนละ job – ดู job เก่าได้จาก dropdown **Previous runs…**

## โครงสร้าง

```
Onsite_Tools_v2/
├── run.bat / run.sh / run_lan.bat   ตัวเปิดโปรแกรม (สร้าง .venv + ติดตั้ง + เปิด browser)
├── requirements.txt
├── settings.json                    port, ค่า default ต่าง ๆ
├── templates/                       CSV template ทุกเครื่องมือ + shc_template.csv
├── data/site_inventory.json         Site Inventory (สร้างอัตโนมัติ, ไม่เข้า git)
├── static/                          index.html, app.js, style.css  (frontend)
└── app/
    ├── __main__.py                  python -m app
    ├── main.py                      FastAPI routes
    ├── core/                        jobs (thread pool + live results), inventory, csv, netmiko, paths, logging
    └── tools/                       หนึ่งไฟล์ต่อหนึ่งเครื่องมือ (TOOL dict + run(ctx, params))
```

### เพิ่มเครื่องมือใหม่

สร้างไฟล์ใน `app/tools/` ที่มี `TOOL = {...}` (id, name, category, fields, columns, runs)
และ `def run(ctx, params)` – ใช้ `ctx.add_row()`, `ctx.update_row()`, `ctx.map_parallel()`,
`ctx.info()/warn()/error()`, `ctx.artifact()` เพื่อส่งผลลัพธ์ไปหน้าเว็บ ระบบจะโหลดให้อัตโนมัติ
(ดู `get_inventory.py` เป็นตัวอย่างสั้นที่สุด)

## Manual start

```bash
.venv\Scripts\python -m app --port 8088            # Windows
.venv/bin/python -m app --host 0.0.0.0 --no-browser
```

## Tests

```bash
.venv\Scripts\python -m pip install -r requirements-dev.txt
.venv\Scripts\python -m pytest tests -q
```

Tests ครอบคลุม tool registry, Site Inventory (import / merge / replace / API), parser ของทุกเครื่องมือ (CDP/LLDP/inventory/SNMP/interface/health check),
CSV loader, job runner (progress / error / stop) และ REST API ผ่าน FastAPI TestClient – ไม่ต้องมีอุปกรณ์จริง
GitHub Actions (`.github/workflows/python-package.yml`) run ชุดนี้บน Python 3.9 / 3.10 / 3.11
