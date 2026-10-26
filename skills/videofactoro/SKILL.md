---
name: videofactoro
description: ใช้ CLI `vf` (videofactoro) สร้าง project เรื่อง ตัวละคร และสถานที่สำหรับวิดีโอ AI ผ่าน Cloudflare โดยไม่ถามผู้ใช้กลางทาง ใช้เมื่อผู้ใช้ขอทำวิดีโอ คลิป การ์ตูน ตัวละคร เรื่อง หรือ story ("สร้าง project เรื่อง…", "ทำคลิป…", "เพิ่มตัวละคร…") หรือพูดถึง videofactoro / vf. Use when the user asks to make a video, clip, character, story or cartoon, create or extend a videofactoro project, or mentions videofactoro or the `vf` command.
---

# videofactoro (vf)

`vf` = CLI สำหรับ agent สั่งงานเอง ไม่มีคำสั่งไหนถามผู้ใช้ รันจาก root ของ repo: `node bin/vf.mjs <คำสั่ง>` (ในเอกสารนี้เขียนสั้นว่า `vf ...`)

## กฎเหล็ก

1. **สร้าง project ก่อนเสมอ** (`vf project create`) ก่อนเพิ่มตัวละคร/สถานที่ใดๆ
2. **อ่านก่อนทำทุกงาน:** `vf project show <slug>` แล้วอ่าน `projects/<slug>/PROJECT.md` (ดู `references/project.md`)
3. **ห้ามถามผู้ใช้กลางทาง** ตัดสินใจเองตาม prompt และกฎในไฟล์นี้ ถ้าขาดข้อมูลให้เลือกค่าที่สมเหตุสมผลแล้วบอกในรายงานท้ายงาน
4. **ห้ามใส่ชื่อลิขสิทธิ์** (ตัวการ์ตูน หนัง เกม ยี่ห้อ) ใน prompt ให้เขียนเป็นตัวละครทั่วไป เช่น "แมวส้มอ้วน" แทนชื่อตัวการ์ตูนจริง
5. **ค้นคลังก่อนสร้างใหม่:** `vf asset find <slug> <คำค้น...>` (คำไทยได้) ถ้ามีของใช้ได้ ให้ใช้ซ้ำ
6. **ห้ามอ่าน พิมพ์ หรือขอค่าใน `.env`** (และ `.dev.vars`, `cloudflare.json`) ผู้ใช้ตั้งค่าเองด้วย `bash tools/set-env.sh` ใน Terminal ของตัวเอง แล้วรัน `node bin/vf.mjs setup` (คือ `vf setup` ห้าม agent รันแทนถ้ายังไม่มีค่า)
7. **แก้ PROJECT.md ได้เฉพาะนอกบล็อก `<!-- vf:auto:... -->`**
8. **รายงานต้นทุนทุกครั้ง** ทุกผลลัพธ์มี `cost.usd` สรุปว่าใช้อะไรเท่าไรในข้อความสุดท้ายถึงผู้ใช้

## ลำดับมาตรฐาน

```
vf doctor                                   # ตรวจ env; exit 3 = หยุด
vf project create --prompt "..." --name <ascii-slug> --dry-run   # ดูแผน + ราคาประเมิน (ไม่เสียเงิน)
vf project create --prompt "..." --name <ascii-slug>             # คืน {job, next}
vf wait <slug>                              # วนจน status = done | failed
vf project show <slug>                      # ตรวจผล
vf character add <slug> --prompt "..."      # เพิ่มตัวละคร (ทางเลือก)
vf place add <slug> --prompt "..."          # เพิ่มสถานที่ (ทางเลือก)
```

- **ใส่ `--name <ascii-slug>` เสมอ** (a-z 0-9 และ `-`) ถ้า prompt เป็นไทยล้วนและไม่ใส่ `--name` ชื่อจะเป็น `project-<8 hex>` prompt เดิมให้ slug เดิมเสมอ จึงรันซ้ำ = ทำต่อจากเดิม
- ตัวเลือกของ `project create`: `--lang`, `--aspect`, `--max-rerolls 0-5`, `--image <ชื่อตัวละคร>=<path>` (ใช้ภาพของผู้ใช้เอง ใส่ซ้ำได้)
- `character add`: `--id`, `--image <path>` (สูงสุด 4 ภาพ), `--replace --id <id>` (แทนที่ตัวละครเดิม ภาพเก่าเก็บใน `ref/old-<stamp>/`)
- `place add`: `--id`, `--max-rerolls`
- `--dry-run` ใช้ได้กับ create / character add / place add: แสดงขั้นตอนและ USD ประเมิน ไม่เสียเงิน
- `vf status <slug>` แสดง job ล่าสุด

## งานยาว: job และ wait

`project create`, `character add`, `place add` คืน `{job, next}` ทันที (ยกเว้นใส่ `--foreground`) แล้วงานรันเบื้องหลัง

1. `vf wait <slug> [job-id]` บล็อกได้สูงสุด 540 วินาที (ปรับด้วย `--timeout`)
2. หมดเวลาแต่ยังไม่เสร็จ = เรียก `vf wait` ซ้ำ **วนจน status เป็น `done` หรือ `failed`**
3. หนึ่ง project รันได้ทีละ job ถ้าสั่งซ้อนจะได้ USAGE (exit 2) ให้ `vf wait` ของเดิมให้จบก่อน
4. `failed` หรือ error: ดู `details.resume` (create, character add, place add) เป็นคำสั่งเดิมที่ต้องรันซ้ำ จะทำต่อจากจุดค้างโดยไม่จ่ายซ้ำ

## ผลลัพธ์และ exit code

stdout มี JSON ก้อนเดียวเสมอ (`{ok:true,...}` หรือ `{ok:false,error:{code,message,details}}`) log ไปที่ stderr

| exit | code | ทำอย่างไร |
|---|---|---|
| 0 | ok | ไปขั้นถัดไป (`next` แนะนำคำสั่งต่อ) |
| 2 | USAGE | แก้ argument / project ไม่มี / job ยังรันอยู่ แล้วเรียกใหม่ |
| 3 | CONFIG | env, token หรือเครดิตมีปัญหา **หยุด ห้ามลองซ้ำ** รายงานผู้ใช้ให้รัน `bash tools/set-env.sh` แล้ว `node bin/vf.mjs setup` |
| 4 | BLOCKED | ติด content filter เขียน prompt ใหม่ให้ทั่วไปและอ่อนลง (ไม่มีชื่อลิขสิทธิ์) แล้วลองใหม่ |
| 5 | PROVIDER | ผู้ให้บริการล่ม/timeout รันคำสั่งเดิมซ้ำ (ใช้ `details.resume`) |
| 1 | INTERNAL | บั๊กของ tool รายงานข้อความ error ตามจริง |

## โหมดวิดีโอ

`vf clip`, `vf film`, `vf motion`: ยังไม่มี (แผน 2–4) ตอนนี้ทำได้ถึงขั้น project, ตัวละคร, สถานที่ ถ้าผู้ใช้ขอวิดีโอจริง ให้สร้าง project ให้เสร็จแล้วบอกว่าขั้นวิดีโอยังไม่เปิดใช้

## รายงานท้ายงาน (ภาษาไทย)

```
สร้างเสร็จ: <ชื่อเรื่อง> (project: <slug>)
ตัวละคร:
- <id> <ชื่อ>: projects/<slug>/characters/<id>/ref/main.png
สถานที่:
- <id>: projects/<slug>/places/<id>/plates/main.jpg
ตัดสินใจเอง: <ค่าที่เลือกเมื่อ prompt ไม่ระบุ>
ต้นทุน (ประเมิน):
| ขั้น | ครั้ง | USD |
| ... |
| รวม | | $X.XX |
```

เอาตัวเลขจาก `cost.usd` ในผลลัพธ์และจากหัวข้อ "ต้นทุนสะสม" ใน PROJECT.md บอกด้วยว่าไม่รวมค่า LLM ของ agent เอง

## อ้างอิง

- `references/project.md`: โครงไฟล์ project, ไฟล์ json ทั้งสามชนิด, กฎแก้ PROJECT.md
- ที่เก็บ project: `$VF_PROJECTS` (ค่าเริ่ม `./projects`)
