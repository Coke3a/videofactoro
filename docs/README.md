# videofactoro

เครื่องมือ CLI `vf` (Node 22 ไม่มี dependency) ที่ให้ LLM agent สร้างโลกของเรื่อง ตัวละคร และสถานที่ด้วย AI ผ่าน Cloudflare Workers AI เท่านั้น แต่ละคำสั่งพิมพ์ JSON หนึ่งก้อนและไม่ถามผู้ใช้ ภาพรวมและวิธีติดตั้งเบื้องต้นอยู่ที่ [README.md](../README.md) และสเปกเต็มอยู่ที่ [docs/superpowers/specs/2026-10-26-videofactoro-design.md](superpowers/specs/2026-10-26-videofactoro-design.md)

## ตั้งค่า

1. รัน `bash tools/set-env.sh` ใน Terminal ของคุณเอง (ค่าคีย์ไม่แสดงบนจอ เขียนลง `.env` แบบ chmod 600)
2. รัน `node bin/vf.mjs setup` เพื่อทดสอบ token และเครดิต
3. ตรวจซ้ำได้ทุกเมื่อด้วย `node bin/vf.mjs doctor` (อ่านอย่างเดียว)

ไม่ต้องคัดลอก `.env.example` หรือพิมพ์คีย์เอง (`.env.example` เป็นแค่รายชื่อตัวแปร) · ห้ามนำ `.env` ไปไว้ใน git (มี pre-commit hook ช่วยกัน: `node tools/install-hooks.mjs`) · `.env` ที่ใช้คือไฟล์ที่ root ของ repo เท่านั้น (env ของ process มาก่อนเสมอ)

## คำสั่ง

| คำสั่ง | ทำอะไร |
|---|---|
| `vf setup` / `vf doctor` | ตั้งค่า / ตรวจสภาพแวดล้อม |
| `vf project create --prompt "..." --name <slug>` | สร้าง project จาก prompt เดียว |
| `vf project show <slug>` | สรุป project เป็น JSON |
| `vf character add <slug> --prompt "..."` | เพิ่มตัวละคร |
| `vf place add <slug> --prompt "..."` | เพิ่มสถานที่ |
| `vf asset find <slug> <คำค้น...>` | ค้นคลังของ project |
| `vf wait <slug> [job-id]` | รอ job เบื้องหลัง (สูงสุด 540 วินาทีต่อครั้ง) |
| `vf status <slug>` | job ล่าสุดของ project |

คำสั่งที่เสียเงินรองรับ `--dry-run` เพื่อดูแผนและราคาประเมินก่อน โหมดวิดีโอ (`clip`, `film`, `motion`) ยังไม่มี

## project อยู่ที่ไหน

ใน `$VF_PROJECTS` (ค่าเริ่มต้น `./projects/` และอยู่ใน `.gitignore`) หนึ่งโฟลเดอร์ต่อหนึ่ง project เริ่มอ่านที่ `projects/<slug>/PROJECT.md`

## ให้ agent ใช้

เปิด Claude Code ใน repo นี้ skill `videofactoro` (`.claude/skills/videofactoro` → `skills/videofactoro`) จะถูกโหลดอัตโนมัติ แล้วสั่งเช่น "สร้าง project เรื่องเพนกวินทำร้านกาแฟ"
