# Network Site Manager

เว็บสำหรับดูแล Network ของแต่ละ Site: สถานะ Site, อุปกรณ์ (Router / Switch / Firewall / WLC / AP), Subnet / VLAN และวงจร WAN

ใช้ environment เดียวกับ **Lab_management (AIT QuickLab)**: Next.js 16, React 19, Tailwind 4, Astryx design system, Prisma 7 + PostgreSQL (pg adapter), Docker + nginx

> **สถานะตอนนี้:** หน้าเว็บอ่านข้อมูลตัวอย่างจาก `src/lib/sample-data.ts` (ข้อมูลสมมติทั้งหมด) ยังไม่ได้ต่อฐานข้อมูลและยังไม่มีระบบ login

## หน้าเว็บ

| Route | เนื้อหา |
|---|---|
| `/` | Dashboard: จำนวน Site/อุปกรณ์, การ์ดสถานะแต่ละ Site, อุปกรณ์ที่ Down / Warning |
| `/sites` | รายชื่อ Site ทั้งหมด ค้นหาและกรองตามสถานะได้ |
| `/sites/[code]` | รายละเอียด Site: ข้อมูลติดต่อ, Health, อุปกรณ์, Subnet / VLAN, วงจร WAN |
| `/devices` | อุปกรณ์ทุกตัวจากทุก Site |
| `/import` | **Import configuration**: อัปโหลด running-config เพื่ออัปเดตข้อมูลอุปกรณ์และ Subnet/VLAN ของ Site |
| `/diagram` | **Diagram**: วาด topology ของ Site จาก config ที่ Import มา |

## Import configuration

- เลือก Site แล้วลากไฟล์ `show running-config` มาวาง (1 ไฟล์ต่อ 1 อุปกรณ์, ไฟล์ละไม่เกิน 2 MB, ครั้งละไม่เกิน 50 ไฟล์) หรือวางเป็นข้อความ
- หน้าเว็บจะแสดงผลการอ่านให้ตรวจก่อน (hostname, platform, version, จำนวน interface/IP/VLAN, Mgmt IP) และบอกว่าแต่ละไฟล์จะอัปเดตอุปกรณ์เดิม เพิ่มอุปกรณ์ใหม่ หรือแทนที่ config เดิม
- รองรับ syntax แบบ Cisco IOS / IOS-XE / NX-OS และ Aruba AOS-CX
- ผลที่ได้: อุปกรณ์ hostname เดียวกันจะได้ OS version และ Mgmt IP จาก config (ลำดับที่ใช้เลือก Mgmt IP: interface ที่ชื่อหรือ description เป็น mgmt/management → Loopback0 → SVI แรก → IP แรก), hostname ใหม่กลายเป็นอุปกรณ์ใหม่, และ interface ที่มี IP จะเพิ่ม Subnet ที่ Site ยังไม่มี
- Config เก็บเป็นไฟล์ใน `data/configs/<SITE>/<hostname>.json` (อยู่ใน .gitignore) โดยเก็บแค่ข้อความดิบและอ่านใหม่ทุกครั้ง พอต่อฐานข้อมูลแล้วจะย้ายไปตาราง `device_configs` (model `DeviceConfig` ใน schema) โดยแก้แค่ `src/lib/config-store.ts`
- ลองใช้งานได้ด้วยไฟล์ตัวอย่างใน `samples/configs/BKK-HQ/` (ข้อมูลสมมติ)

## Diagram

running-config ไม่ได้บอกว่าพอร์ตไหนต่อกับอะไร เส้นเชื่อมจึง**อนุมาน**จาก 2 หลักฐาน (วางเมาส์บนเส้นเพื่อดูว่ามาจากหลักฐานไหน):

1. **IP วงเดียวกันแบบ /30 หรือ /31** ระหว่างสองอุปกรณ์ → link แบบ point-to-point
2. **Description ของ interface ระบุชื่ออุปกรณ์ปลายทาง** เช่น `TO HQ-CORE-01 Gi1/0/10` ถ้าระบุชื่อ interface ปลายทางด้วย ทั้งสองฝั่งจะถูกจับคู่เป็นเส้นเดียว

นอกจากนี้:
- Member ของ Port-channel ที่ชี้ไปอุปกรณ์เดียวกับ Port-channel จะรวมเป็น link เดียว
- Subnet วงใหญ่กว่า /30 ที่อุปกรณ์ตั้งแต่ 2 ตัวขึ้นไปใช้ร่วมกัน แสดงเป็น LAN segment (VLAN)
- อุปกรณ์ที่ถูกอ้างถึงใน description แต่ยังไม่ได้ Import config จะแสดงเป็นกรอบเส้นประ (เฉพาะอุปกรณ์ที่มีอยู่ใน Site)
- Interface ที่ shutdown จะไม่ถูกนำมาใช้

การใช้งาน: ลากอุปกรณ์เพื่อจัดตำแหน่ง (ตำแหน่งจะถูกจำไว้ใน browser นั้น), ลากพื้นหลังเพื่อเลื่อน, ใช้ล้อเมาส์เพื่อซูม, คลิกอุปกรณ์เพื่อดูตาราง interface และกด Download SVG เพื่อบันทึกภาพ

> ยังไม่มีระบบ login ทุกคนที่เข้าเว็บได้จะ Import และลบ config ได้ ต้องเพิ่ม auth ก่อนเปิดให้ใช้งานจริง

## รันบนเครื่อง

```powershell
cd Network_Site_Manager
npm install
npm run dev
```

เปิด http://localhost:8020

## ต่อฐานข้อมูล (ขั้นต่อไป)

1. คัดลอก `.env.example` เป็น `.env` แล้วใส่ `DATABASE_URL` (Postgres, ระบุ `?schema=`)
2. `npm run db:push` เพื่อสร้างตารางตาม `prisma/schema.prisma`
3. เปลี่ยนเนื้อฟังก์ชันใน `src/lib/data.ts` ให้ query ผ่าน `src/lib/prisma.ts` โดย signature ของฟังก์ชันเหมือนเดิม หน้าเว็บจึงไม่ต้องแก้

## Deploy

```powershell
docker compose --env-file .env.production up -d --build
```

nginx เปิดที่พอร์ต 8020 และ app ไม่ถูก publish ออกมาตรง ๆ (รูปแบบเดียวกับ Lab_management) ถ้าจะ publish ใต้ path ย่อย ให้ตั้ง `NEXT_PUBLIC_BASE_PATH` ตอน build

## ตรวจสอบ

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```
