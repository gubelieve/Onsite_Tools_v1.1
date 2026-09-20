# Onsite Tools v3

ชุดเครื่องมือ network onsite แบบ Web App ที่ **รันบนเครื่องตัวเองทั้งหมด** – App และ Database อยู่ในโฟลเดอร์นี้
**ไม่ต้อง login** และ **ไม่ใช้ Python** ใช้ stack เดียวกับ `cs-fse2/lab_management` (AIT QuickLab)

## Technology Stack

| ส่วน | ใช้อะไร | หมายเหตุ |
|------|---------|----------|
| Framework | Next.js 16 (React 19, App Router, Server Actions) + TypeScript | เหมือน lab_management |
| UI | Astryx (`@astryxdesign/core` + `theme-neutral`) + Tailwind CSS v4, lucide icons, dark mode | `globals.css` / Providers / ThemeToggle ยกมาจาก lab_management |
| ORM / DB | Prisma 7 + **SQLite** (`@prisma/adapter-better-sqlite3`) → ไฟล์เดียว `data/onsite.db` | lab_management ใช้ PostgreSQL – ที่นี่เป็น local file |
| Auth | **ไม่มี** – server ฟังที่ `127.0.0.1` เท่านั้น | ไม่มี NextAuth / LDAP |
| SSH | `ssh2` + driver ของเราเอง (`src/lib/net/ssh.ts`) | แทน netmiko |
| SNMP | `net-snmp` (v2c / v3) | แทน pysnmp |
| REST | `node:https` (`src/lib/net/http.ts`) รองรับ self-signed cert + cookie | แทน requests |
| Screenshot | `puppeteer-core` + Chrome / Edge ที่ติดตั้งในเครื่อง | แทน selenium |
| Excel / CSV | `exceljs` + CSV parser ของเราเอง | แทน pandas |
| Tests | Vitest – รวม **SSH server จำลองแบบ Cisco** สำหรับทดสอบ driver | |

## เริ่มใช้งาน (Copy folder ไปวางแล้ว run)

1. ติดตั้ง **Node.js 22 LTS** (ขั้นต่ำ 20.19) จาก https://nodejs.org/
2. Copy โฟลเดอร์ `Onsite_Tools_v3` ไปไว้ที่ไหนก็ได้ แล้วดับเบิลคลิก **`run.bat`** (Linux/macOS: `./run.sh`)
   * ครั้งแรก: `npm install` → สร้าง database → build (ต้องต่อ internet ครั้งเดียว ประมาณ 5 นาที)
   * ครั้งต่อไปเปิดได้ในไม่กี่วินาที
3. Browser เปิด **http://127.0.0.1:8090** ให้อัตโนมัติ

| คำสั่ง | ผล |
|--------|----|
| `run.bat` | ใช้เฉพาะเครื่องนี้ (127.0.0.1) |
| `run.bat --lan` | ให้เครื่องอื่นใน LAN เข้าได้ที่ `http://<IP เครื่องนี้>:8090` – **ไม่มี login ใครเข้าได้ก็ใช้ได้** ใช้เฉพาะใน network ที่ไว้ใจ |
| `run.bat --rebuild` | build ใหม่หลังแก้ source |

**เครื่องที่ไม่มี internet:** run ครั้งแรกบนเครื่องที่มี internet แล้ว copy ทั้งโฟลเดอร์ (รวม `node_modules`, `.next`, `data`) ไปวาง
– ใช้ได้เลยถ้าเป็น OS เดียวกันและ Node.js major version เดียวกัน (มี native module `better-sqlite3`)

## วิธีใช้

1. เมนู **Site Inventory** → Import รายการอุปกรณ์ (CSV / XLSX) ครั้งเดียว ข้อมูลเก็บใน database
2. เลือกเครื่องมือ → เลือก **Device list** + **Device Category** (แสดงจำนวนอุปกรณ์ที่เลือก) → ใส่ user / password → **Run**
3. ผลลัพธ์ขึ้นสดในตาราง: **View** ดู output เต็ม, **Stop**, **Export CSV**, ดาวน์โหลดไฟล์ผลลัพธ์
4. ทุก run ถูกบันทึกใน **Run History** (เปิดดูย้อนหลังได้แม้ restart) – *ไม่มีการเก็บ password*
5. **Settings** ตั้งค่า default (username, device type, จำนวน session, SSH timeout, SNMP community)

### Site Inventory

* คอลัมน์ IP ที่รองรับ: `IP_Address` / `ip_mgmt` / `ip` / `managementIpAddress`; **Device Category** อ่านจากคอลัมน์
  `Device_Category` / `category` / `Site` / `zone` (ไฟล์เดิมที่ใช้ `Site` import ได้เหมือนเดิม); อื่น ๆ: `Hostname`,
  `Device_Type`, `Model`, `Brand`, `Description` – คอลัมน์อื่น (เช่น `command`) เก็บไว้เป็น extra
* แต่ละไฟล์ = หนึ่ง **list** (ค่าเริ่มต้นคือชื่อไฟล์) – โหมด **Merge** (เพิ่ม + update IP ซ้ำ) หรือ **Replace**
* ค้นหา / กรอง, เพิ่ม-แก้-ลบทีละตัว, ลบทั้ง list, Export CSV, ประวัติการ import
* เลือก list = All → ตัด IP ซ้ำข้าม list ให้อัตโนมัติ
* ใส่ IP แบบ `10.0.0.1:2222` ได้ ถ้า SSH ไม่ได้อยู่ที่ port 22

## เครื่องมือ (14)

| กลุ่ม | เครื่องมือ | แหล่งอุปกรณ์ |
|-------|-----------|---------------|
| SSH Tools | Config Devices (Verify / Config mode, คอลัมน์ต่อคำสั่ง, `command` ต่ออุปกรณ์), IOS Upgrade (6 stage), Client Status Checker | Site Inventory |
| Inventory | Get Inventory, CDP Inventory, LLDP Inventory, SNMP Inventory, Verify SNMP User | Site Inventory |
| Log Analysis | Interface Report, Security Health Check | โฟลเดอร์ log หรือ upload |
| Catalyst Center / SD-WAN | DNAC REST API, DNAC Port Assignment, SD-WAN Site List, Capture DNAC | CSV เฉพาะงาน / Site Inventory (Port Assignment) |

Device type `autodetect` ลองคำสั่งปิด paging ของ Cisco → Huawei → HPE Comware → Juniper → ProCurve ตามลำดับ
รองรับ key-exchange / cipher รุ่นเก่า (IOS เก่า) และ keyboard-interactive login

## IOS Upgrade – การส่งไฟล์ image (Stage 1)

| Transfer method | ต้องเตรียมอะไร | หมายเหตุ |
|-----------------|----------------|----------|
| **Built-in FTP server** (ค่าเริ่มต้น) | ไม่ต้องเปิด FTP server เอง – App เปิด port 21 ให้เฉพาะช่วงที่ Stage 1 ทำงาน แล้วปิดเอง | read-only, ให้ดาวน์โหลดได้เฉพาะไฟล์ image ที่เลือก, user/password สุ่มใหม่ทุก run และไม่แสดงในผลลัพธ์ / log ครั้งแรก Windows จะถาม firewall ของ Node.js ให้กด Allow |
| **SCP push** | ไม่มีอะไร listen บนเครื่องนี้ – App ต่อ SSH เข้าไปส่งไฟล์เอง | ถ้าอุปกรณ์ยังไม่มี `ip scp server enable` App จะใส่ให้ (ไม่ได้ `write memory`), user ต้องเป็น privilege 15, SCP ของ IOS ช้ากว่า FTP |
| External FTP server | FTP server ที่เปิดไว้อยู่แล้ว (FileZilla, IIS) | พฤติกรรมเดิม |

> **Windows Firewall:** built-in FTP ต้องให้อุปกรณ์ "ต่อเข้ามา" ที่เครื่องนี้ ถ้าเคยกด Cancel ตอน Windows ถาม
> Windows จะสร้าง rule **Block ขาเข้า** ของ `node.exe` ค้างไว้ และ copy จะล้มเหลวทุกครั้ง (Block ชนะ Allow เสมอ
> การเพิ่ม rule Allow ทับไม่ช่วย ต้องลบ rule Block ทิ้ง) เครื่องมือจะตรวจให้และบอกชื่อ rule ในข้อความ error
> วิธีแก้ – เปิด PowerShell แบบ Run as administrator:
>
> ```powershell
> Get-NetFirewallRule -DisplayName 'Node.js JavaScript Runtime' |
>   Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' } | Remove-NetFirewallRule
> New-NetFirewallRule -DisplayName 'Onsite Tools FTP' -Direction Inbound -Action Allow `
>   -Program 'C:\Program Files
odejs
ode.exe'
> ```
>
> ถ้าไม่มีสิทธิ์ admin ให้ใช้ **SCP push** แทน – ไม่ต้องเปิดอะไรรอที่เครื่องนี้เลย

ช่อง **IOS image file** กด **Browse file** เพื่อเปิดหน้าต่างเลือกไฟล์ของ Windows – ได้ path เต็มโดยไม่มีการ copy / upload ไฟล์
(ใช้ได้เฉพาะ browser บนเครื่องที่ run App; ถ้าเข้าผ่าน `--lan` ให้วาง path เอง) ช่อง Log folder ก็มีปุ่ม Browse folder เช่นกัน

## ข้อมูลอยู่ที่ไหน

| โฟลเดอร์ | เนื้อหา |
|----------|---------|
| `data/onsite.db` | Site Inventory, Run History, Settings (SQLite) |
| `logs/<tool>/<วันเวลา>/` | output ต่ออุปกรณ์ของแต่ละ run + log รายวัน |
| `exports/`, `screenshots/`, `uploads/` | ไฟล์ผลลัพธ์, ภาพ capture, ไฟล์ที่ upload |

ทั้งหมดอยู่ใน `.gitignore` เพราะมี IP / config ของลูกค้า – **สำรอง inventory = copy `data/onsite.db`**

## พัฒนาต่อ

```bash
npm install          # ติดตั้ง + prisma generate
npx prisma db push   # สร้าง / update data/onsite.db ตาม prisma/schema.prisma
npm run dev          # http://127.0.0.1:8090 (hot reload)
npm test             # vitest: parsers, CSV, inventory, tool registry, SSH driver + IOS upload กับ fake Cisco device, FTP server, SCP
npm run lint && npm run typecheck
```

```
src/
├── app/                  หน้าเว็บ (dashboard, site-inventory, tools/[id], history, settings) + api/ route handlers
├── actions/              Server Actions (inventory, settings)
├── components/           app-sidebar, tool-runner (ฟอร์มจาก field definition), job-panel (ผลลัพธ์สด)
└── lib/
    ├── jobs.ts           job runner ใน memory + บันทึกลง JobRun เมื่อจบ
    ├── inventory.ts      Site Inventory (Prisma)
    ├── net/ssh.ts        SSH driver (prompt detection, paging, config mode, legacy algorithms)
    ├── net/http.ts       HTTP client สำหรับ DNAC / vManage
    └── tools/            หนึ่ง ToolDef ต่อเครื่องมือ – เพิ่มเครื่องมือใหม่ = เพิ่ม ToolDef แล้วใส่ใน tools/index.ts
```

### เพิ่มเครื่องมือใหม่

สร้าง `ToolDef` (`id`, `name`, `category`, `fields`, `columns`, `runs`, `run(ctx, params)`) แล้วเพิ่มใน `TOOLS`
ที่ `src/lib/tools/index.ts` – เมนู, หน้าเว็บ, ฟอร์ม และ API ถูกสร้างให้อัตโนมัติ ใน `run` ใช้ `ctx.addRow / updateRow /
mapParallel / info / warn / error / artifact / checkStop` (ดู `getInventory` ใน `ssh-tools.ts` เป็นตัวอย่าง)

## ต่างจาก v2 (Python)

* ไม่มี Python / venv – ใช้ Node.js อย่างเดียว
* ข้อมูลอยู่ใน SQLite แทนไฟล์ JSON, Run History อยู่ถาวร
* Capture DNAC ใช้ Chrome / Edge ที่มีในเครื่อง ไม่ต้องมี chromedriver
* IOS Upgrade stage 1 อ่าน progress ผ่าน SSH session ที่สอง (ของเดิมใช้ session เดียวกับที่ `copy` ค้างอยู่)
* ไม่มี "Generate Report" (ydata-profiling เป็น Python) – ใช้ Export CSV แทน

**ยังไม่ได้ทดสอบกับอุปกรณ์จริง** – SSH driver ผ่านการทดสอบกับ Cisco CLI จำลองเท่านั้น ควรลองกับอุปกรณ์ 1–2 ตัว
(เริ่มจาก Get Inventory / Config Devices โหมด Verify) ก่อนใช้กับ site จริง โดยเฉพาะ Config mode และ IOS Upgrade
