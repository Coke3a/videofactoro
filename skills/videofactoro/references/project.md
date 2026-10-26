# โครง project

ที่เก็บ: `$VF_PROJECTS` (ค่าเริ่ม `./projects/` ใน repo, อยู่ใน `.gitignore`)

```
projects/<slug>/
  PROJECT.md            อ่านก่อนเสมอ: เรื่อง โลก สไตล์ เสียง กฎ และแผนที่ไฟล์
  project.json          ค่าที่เครื่องอ่าน (ทั้ง bible + slug, aspect, lang, created_at, version)
  EPISODES.md           ตอนที่ทำแล้ว (สร้างอัตโนมัติ)
  characters/<id>/      CHARACTER.md, character.json, ref/main.png (ภาพหลัก)
                        ref/extra-<n>.png (ภาพเสริมจาก character add --image) · ref/old-<stamp>/ (ภาพเดิมหลัง --replace)
  places/<id>/          PLACE.md, place.json, plates/main.jpg
  library/              index.json + blobs/ (คลังที่ `vf asset find` ค้น · ภาพที่ไม่ได้เลือกอยู่ใน library/blobs/ พร้อมผล QA ในช่อง qa)
  .vf/                  costs.jsonl (ต้นทุนทุกการเรียก) + state ของคำสั่ง (create-state.json, character-<key>-state.json, place-<key>-state.json)
  .jobs/<job-id>/       job.json, job.log, job.pid, heartbeat ของ job เบื้องหลัง
```

ไฟล์ใน `.vf/` และ `.jobs/` tool เป็นคนเขียน ห้ามแก้หรือลบระหว่างที่ยังมี job ค้าง (ใช้ทำต่อจากจุดที่พัง)

(clips/ จะมีเมื่อโหมดวิดีโอเปิดใช้ ตอนนี้ยังไม่มี)

## PROJECT.md

หัวข้อตายตัว: เรื่องย่อ · โลก · สไตล์ภาพ · เสียงและอารมณ์ · ตัวละคร · สถานที่ · กฎของเรื่อง · แผนที่ไฟล์ · ต้นทุนสะสม

ส่วนที่ tool เขียนอัตโนมัติ (ตาราง ตัวละคร/สถานที่ แผนที่ไฟล์ ต้นทุน) อยู่ระหว่าง marker:

```
<!-- vf:auto:<name> -->
...tool เขียนทับทุกครั้ง...
<!-- /vf:auto:<name> -->
```

**กฎ: แก้ PROJECT.md ได้เฉพาะนอกบล็อก `<!-- vf:auto:... -->`** เช่น เพิ่มกฎของเรื่อง มุกประจำ สิ่งที่ห้ามซ้ำ ข้อความในบล็อกจะถูกเขียนทับ และห้ามลบหรือแก้ marker

## ไฟล์ json

- `project.json`: `slug`, `lang`, `aspect`, `style_prompt` (ใส่ใน prompt ภาพทุกครั้งแบบคำต่อคำ), `title`, `palette`, `narrator`, `characters`, `places`, `created_at`, `version` ฯลฯ
- `characters/<id>/character.json`: `id`, `name`, `role`, `look` (รูปร่าง ใส่ใน prompt แบบคำต่อคำ), `personality`, `voice` (`{tts_voice, description}`), `ref` (path ภาพหลัก `ref/main.png`), `extra_refs` (ภาพเสริม `ref/extra-<n>.png` ถ้ามี)
- `places/<id>/place.json`: `id`, `name`, `desc` (คำอธิบายฉาก), `plate` (path ภาพฉาก เช่น `plates/main.jpg`)

id ของตัวละคร/สถานที่เป็น ASCII (a-z 0-9 `-`) และไม่ซ้ำกันข้ามสองชนิด อย่าแก้ json ด้วยมือถ้าใช้คำสั่งทำได้ (`vf character add --replace --id <id>`)
