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

### รายชื่ออุปกรณ์ในฟอร์ม (ทุกเครื่องมือที่ใช้ Site Inventory)

ใต้ช่อง **Device list** + **Device Category** ของทุกเครื่องมือ จะมีตารางบอกว่า *ตอนนี้เลือกอุปกรณ์ตัวไหนอยู่บ้าง*
(IP Address, Hostname, Device Category, Device type, Model, **Description**, Device list) เปลี่ยน list หรือ category แล้วตารางอัปเดตทันที

* เป็น **ชุดเดียวกับที่ run จริง** – ลำดับและการตัด IP ซ้ำใช้โค้ดเส้นเดียวกัน (`dedupeByIp`) จึงไม่มีกรณี "เห็นอย่างหนึ่ง แต่ยิงอีกอย่างหนึ่ง"
* **ติ๊ก checkbox หน้าแต่ละแถวเพื่อเลือก run แค่บางตัว** – ค่าเริ่มต้นติ๊กครบทุกตัว, ติ๊กหัวตารางเพื่อเลือก/ยกเลิกทั้งหมด
  (ถ้าพิมพ์ filter อยู่ จะเลือกเฉพาะแถวที่เห็น), กด **Use all** เพื่อกลับไปใช้ทั้งหมด หัวตารางจะบอก `3 of 10 device(s) ticked`
  ถ้าไม่ติ๊กเลยแล้วกด Run จะเตือนและไม่ยิงอะไรออกไป และการเปลี่ยน list/category จะรีเซ็ตกลับเป็นติ๊กครบเสมอ
* มีช่อง filter เมื่อเกิน 8 ตัว, กด **Hide devices / Show devices** ได้ (จำค่าไว้ใน browser)
* รายการยาวสุด 300 แถว แต่ตัวเลข "N device(s) will be used" เป็นจำนวนจริงเสมอ

## เครื่องมือ (15)

| กลุ่ม | เครื่องมือ | แหล่งอุปกรณ์ |
|-------|-----------|---------------|
| SSH Tools | Config Devices (Verify / Config mode, คอลัมน์ต่อคำสั่ง, `command` ต่ออุปกรณ์), IOS Upgrade (6 stage + cleanup flash), Client Status Checker | Site Inventory |
| Inventory | Get Inventory, CDP Inventory, LLDP Inventory, SNMP Inventory, Verify SNMP User | Site Inventory |
| Log Analysis | Interface Report, **Compare Configuration**, Security Health Check | โฟลเดอร์ log หรือ upload |
| Catalyst Center / SD-WAN | **DNAC REST API** (เรียก API ไหนก็ได้), DNAC Port Assignment, SD-WAN Site List, Capture DNAC | เลือก endpoint ในฟอร์ม / CSV เฉพาะงาน / Site Inventory (Port Assignment) |

Device type `autodetect` ลองคำสั่งปิด paging ของ Cisco → Huawei → HPE Comware → Juniper → ProCurve ตามลำดับ
รองรับ key-exchange / cipher รุ่นเก่า (IOS เก่า) และ keyboard-interactive login

## IOS Upgrade – การส่งไฟล์ image (Stage 1)

| Transfer method | ต้องเตรียมอะไร | หมายเหตุ |
|-----------------|----------------|----------|
| **Built-in FTP server** (ค่าเริ่มต้น) | ไม่ต้องเปิด FTP server เอง – App เปิด port 21 ให้เฉพาะช่วงที่ Stage 1 ทำงาน แล้วปิดเอง | read-only, ให้ดาวน์โหลดได้เฉพาะไฟล์ image ที่เลือก, user/password สุ่มใหม่ทุก run และไม่แสดงในผลลัพธ์ / log ครั้งแรก Windows จะถาม firewall ของ Node.js ให้กด Allow |
| **SCP push** | ไม่มีอะไร listen บนเครื่องนี้ – App ต่อ SSH เข้าไปส่งไฟล์เอง | ถ้าอุปกรณ์ยังไม่มี `ip scp server enable` App จะใส่ให้ (ไม่ได้ `write memory`), user ต้องเป็น privilege 15, SCP ของ IOS ช้ากว่า FTP |
| External FTP server | FTP server ที่เปิดไว้อยู่แล้ว (FileZilla, IIS) | พฤติกรรมเดิม |

**ระหว่างโอนไฟล์ = หลอดโหลด ไม่ใช่ log ไหลเรื่อย ๆ** – Stage 1 ใช้ **1 แถวต่ออุปกรณ์** แล้วอัปเดตแถวเดิมทุกวินาที
ในคอลัมน์ **Progress** เป็นหลอด (เต็มแล้วเปลี่ยนเป็นสีเขียว) ส่วน Message บอก `412.5 / 1,199.8 MB (34.4%) · 5.8 MB/s · 2m 16s left`
และหลอดด้านบนสุดของผลลัพธ์นับเป็น **MB ที่ส่งไปแล้ว** (ไม่ใช่จำนวนอุปกรณ์) เฉพาะ Stage 1 – ใช้ได้ทั้ง 3 transfer method

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

## IOS Upgrade – Session (stage ทั้งหมดอยู่โฟลเดอร์เดียวกัน)

การ upgrade หนึ่งครั้งใช้หลาย stage และแต่ละ stage คือหนึ่ง run – IOS Upgrade จึงรวบไว้เป็น **Session**

* กด Stage แรก = เปิด session ใหม่ → โฟลเดอร์ `logs/upgrade-ios/session_<วันเวลา>/`
* Stage ถัด ๆ ไป **เขียน log ลงโฟลเดอร์เดิม** และตารางผลลัพธ์จะ **แสดงแถวของทุก stage** ตั้งแต่ stage แรก ไม่ใช่เฉพาะ stage ล่าสุด
* แถบด้านบนฟอร์มบอกว่า session ไหนเปิดอยู่ เริ่มเมื่อไร ผ่าน stage อะไรมาแล้ว และอยู่ที่ path ไหน
* กด **Done — start a new session** เมื่อจบงานของเครื่องชุดนั้น → stage ครั้งถัดไปจึงเริ่มโฟลเดอร์ใหม่

ในโฟลเดอร์ session มี `stage_<n>_<ip>_<hostname>.log` (คำสั่ง + output ทุกคำสั่ง), `job.log`, `session.json`
และ `session_results.csv` ที่รวมผลของทุก stage – สถานะ session เก็บไว้ในไฟล์ จึงไม่หายถ้าปิด/เปิด App ใหม่

## IOS Upgrade – Cleanup: ลบ image เก่าที่ไม่ได้ใช้ (`install remove inactive`)

ใช้ตอน flash ไม่พอสำหรับ image ใหม่ แยกเป็น 2 ปุ่ม เพื่อให้ **เห็นรายชื่อไฟล์ก่อนแล้วค่อย confirm**

| ปุ่ม | ทำอะไร |
|------|--------|
| **Cleanup: list inactive images** | สั่ง `install remove inactive` แล้ว **ตอบ n** – อุปกรณ์บอกว่าจะลบไฟล์อะไรบ้าง ขึ้นในตารางไฟล์ละ 1 แถว (Status = `Will be deleted`) **ไม่มีอะไรถูกลบ** |
| **Cleanup: remove inactive images** | ปุ่มสีแดง มี confirm ก่อน – สั่งคำสั่งเดิมแล้ว **ตอบ y** ลบจริง แล้วรายงานว่าลบกี่ไฟล์ / ได้พื้นที่คืนกี่ MB (เทียบ `dir flash:` ก่อน-หลัง) |

* ไฟล์ที่ image ที่กำลัง run ใช้อยู่ อุปกรณ์จะไม่ลบให้เอง (`File is in use, will not delete`) และ **ไม่มีการ reload**
* stack จะแยกให้เป็นรายสมาชิก เช่น `switch 1: /flash/cat9k-espbase...pkg` เพราะไฟล์ชื่อเดียวกันบนคนละ switch คือคนละไฟล์
* 2 ปุ่มนี้ **ไม่ต้องเลือก IOS image file** (ทำงานกับของที่อยู่บน flash อยู่แล้ว) กดได้เลยแม้ช่อง image ว่าง
* อุปกรณ์ที่เป็น bundle mode / IOS เก่าจะไม่มีคำสั่งนี้ – เครื่องมือจะบอกตรง ๆ ว่าต้องใช้ `delete flash:<file>` แทน
* ทั้ง log และรายชื่อไฟล์ถูกเก็บลงโฟลเดอร์ session เดียวกับ stage อื่น ๆ

## DNAC REST API – เรียก API ของ Catalyst Center

ไม่ต้องเขียน script / ไม่ต้องทำ CSV ก่อน: ใส่ URL + user/password ของ Catalyst Center แล้ว **เลือก endpoint จากรายการ** (หรือพิมพ์ path เอง) กด Send request

สิ่งที่เครื่องมือจัดการให้ตามสเปคของ Cisco ([developer.cisco.com/docs/catalyst-center](https://developer.cisco.com/docs/catalyst-center/)):

| เรื่อง | ทำอะไรให้ |
|--------|-----------|
| **Login** | `POST /dna/system/api/v1/auth/token` แบบ Basic auth → ได้ `Token` (อายุ 60 นาที) แล้วแนบ `X-Auth-Token` ให้ทุก request เอง |
| **Paging** | Catalyst Center ส่งได้สูงสุด **500 record ต่อครั้ง** และ `offset` เริ่มที่ **1** – ติ๊ก *Fetch every page* แล้วมันจะไล่ยิงจนครบ (มี *Stop after this many records* กันหลุด) |
| **ผลลัพธ์** | แกะ `{"response": …}` ออกให้ แล้วแปลงเป็น **ตาราง** (list = 1 แถวต่อ record, record เดียว = Field/Value) → Export CSV ได้เลย และเซฟ JSON ดิบเป็นไฟล์แนบ |
| **Task** | ทุก POST/PUT/DELETE ของ Catalyst Center ตอบกลับเป็น `taskId` ไม่ใช่ผลลัพธ์ – เครื่องมือจะตาม `GET /dna/intent/api/v1/task/{id}` ให้ และถ้า task สร้างไฟล์ไว้ (`fileId`) ก็จะไปดึง `GET /dna/intent/api/v1/file/{id}` มาให้ด้วย (Command Runner ใช้ทางนี้) |
| **{id} ในพาธ** | endpoint ที่มี `{id}` / `{ip}` ใส่ค่าในช่อง *Value for {id} / {ip} in the path* ช่องเดียว |
| **Query** | พิมพ์ `key=value` บรรทัดละอัน ไม่ต้อง escape เอง (`#` = comment) |

Endpoint ที่ใส่ไว้ให้เลือก เช่น network-device (+count, by UUID, by IP, config), interface, site / site-health / membership,
network-health, client-health, issues, client-detail, SDA port assignments & fabric sites, SWIM images, templates, compliance,
Command Runner (`legit-reads` + `read-request`) และ task / file

ปุ่ม **Run URL list (CSV)** คือพฤติกรรมเดิม (ไฟล์ `URL_Name,Endpoint` แล้ว GET ทีละบรรทัด) ยังอยู่ครบ

## Compare Configuration – เทียบ Before / After

ใช้คู่กับ **Config Devices**: run เก็บ config ไว้ก่อนเข้างานหนึ่งรอบ เข้างานเสร็จ run เก็บอีกรอบ แล้วเอา 2 โฟลเดอร์มาเทียบกัน

1. **Before: log folder** / **After: log folder** – กด Browse เลือกโฟลเดอร์ `logs/config-devices/<วันเวลา>` ของแต่ละรอบ
2. จับคู่อุปกรณ์จาก **IP ในชื่อไฟล์** (ถ้าไม่มี IP ใช้ hostname) – ไฟล์ `job.log` ของ run ถูกข้ามให้อัตโนมัติ
3. ผลลัพธ์ต่ออุปกรณ์: `Same` / `Changed` (+กี่บรรทัด −กี่บรรทัด) / `Missing in After` / `New in After`
4. กด **View** เปิดหน้าต่าง **เทียบ 2 ฝั่งแบบ MobaDiff / WinMerge** – before ซ้าย after ขวา มีเลขบรรทัดทั้งสองข้าง
   บรรทัดที่หายไป**ชมพู** บรรทัดที่เพิ่มมา**เขียว** ฝั่งที่ไม่มีคู่เป็นช่องเทา เลื่อนพร้อมกันทั้งสองฝั่ง
   ติ๊ก **Hide unchanged lines** เพื่อดูเฉพาะบรรทัดที่เปลี่ยน

| ช่อง | ใช้ทำอะไร |
|------|-----------|
| **Ignore lines matching** | regex บรรทัดละ 1 อัน สำหรับบรรทัดที่เปลี่ยนเองทุก run – ค่าเริ่มต้นตัด `Building configuration`, `Current configuration :`, `Last configuration change`, `ntp clock-period`, `uptime is`, `Time source is` ออกให้แล้ว (ลบให้ว่างถ้าอยากเทียบทุกบรรทัดจริง ๆ) |
| **Context lines** | จำนวนบรรทัดรอบ ๆ จุดที่เปลี่ยน (ค่าเริ่มต้น 3) – ส่วนที่ถูกข้ามจะมีแถบ `⋯ N unchanged line(s) ⋯` คั่นให้เห็น |
| **Keep the whole file** | เก็บทุกบรรทัดของทั้ง 2 ไฟล์ เพื่อให้เลื่อนดูได้ตั้งแต่ต้นจนจบเหมือน MobaDiff (ไฟล์ใหญ่จะกินพื้นที่มากกว่า) |
| **Show only devices that changed** | ซ่อนตัวที่เหมือนเดิม เวลามีอุปกรณ์เยอะ |

ไฟล์ที่ได้: `<hostname>-<ip>.diff` ต่ออุปกรณ์ + `compare_<วันเวลา>.diff` รวมทุกตัว (เป็นปุ่มดาวน์โหลด) อยู่ใน `logs/compare-config/<วันเวลา>/`
กด **Zip log files** ได้ทั้งชุดเหมือนเครื่องมืออื่น

## ปุ่ม Zip log files

ทุก run มีปุ่ม **Zip log files** ข้าง Export CSV (เช่น Config Devices) – ดาวน์โหลดไฟล์ `.zip` ไฟล์เดียวที่มี

* `results.csv` – ตารางผลลัพธ์ของ run นั้น
* `run.log` – log ของ run (พร้อมหัวข้อ tool / เวลาเริ่ม-จบ / สถานะ)
* ไฟล์ทั้งหมดในโฟลเดอร์ของ run เช่น log ต่ออุปกรณ์ของ Config Devices หรือทั้ง session ของ IOS Upgrade

สะดวกสำหรับแนบส่งงาน – zip เขียนเองใน `src/lib/zip.ts` (ไม่ต้องลง library เพิ่ม, เปิดด้วย Explorer ของ Windows ได้)

## ข้อมูลอยู่ที่ไหน

| โฟลเดอร์ | เนื้อหา |
|----------|---------|
| `data/onsite.db` | Site Inventory, Run History, Settings (SQLite) |
| `data/sessions.json` | session ที่ยังเปิดอยู่ของแต่ละ tool (ลบได้ = เหมือนกด Done) |
| `logs/<tool>/<วันเวลา>/` | output ต่ออุปกรณ์ของแต่ละ run + log รายวัน |
| `logs/upgrade-ios/session_<วันเวลา>/` | ทุก stage ของ upgrade หนึ่งครั้ง (จนกว่าจะกด Done) |
| `exports/`, `screenshots/`, `uploads/` | ไฟล์ผลลัพธ์, ภาพ capture, ไฟล์ที่ upload |

ทั้งหมดอยู่ใน `.gitignore` เพราะมี IP / config ของลูกค้า – **สำรอง inventory = copy `data/onsite.db`**

## พัฒนาต่อ

```bash
npm install          # ติดตั้ง + prisma generate
npx prisma db push   # สร้าง / update data/onsite.db ตาม prisma/schema.prisma
npm run dev          # http://127.0.0.1:8090 (hot reload)
npm test             # vitest: parsers, CSV, inventory, tool registry, SSH driver + IOS upload กับ fake Cisco device, FTP server, SCP, session, zip
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

## ต่างจาก v2 (Python edition ที่ถูกแทนที่)

v2 เป็น web app รุ่นก่อนหน้าที่เขียนด้วย Python (FastAPI) – ถูกลบออกจาก repo แล้ว เพราะ v3 ทำงานแทนได้ทั้งหมด
(ถ้ายังต้องการโค้ดเดิม ดูได้จาก git history ก่อน commit ที่ลบ หรือโฟลเดอร์สำเนาในเครื่อง)

* ไม่มี Python / venv – ใช้ Node.js อย่างเดียว
* ข้อมูลอยู่ใน SQLite แทนไฟล์ JSON, Run History อยู่ถาวร
* Capture DNAC ใช้ Chrome / Edge ที่มีในเครื่อง ไม่ต้องมี chromedriver
* IOS Upgrade stage 1 อ่าน progress ผ่าน SSH session ที่สอง (ของเดิมใช้ session เดียวกับที่ `copy` ค้างอยู่)
* ไม่มี "Generate Report" (ydata-profiling เป็น Python) – ใช้ Export CSV แทน

**ยังไม่ได้ทดสอบกับอุปกรณ์จริง** – SSH driver ผ่านการทดสอบกับ Cisco CLI จำลองเท่านั้น ควรลองกับอุปกรณ์ 1–2 ตัว
(เริ่มจาก Get Inventory / Config Devices โหมด Verify) ก่อนใช้กับ site จริง โดยเฉพาะ Config mode และ IOS Upgrade
