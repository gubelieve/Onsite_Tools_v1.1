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
