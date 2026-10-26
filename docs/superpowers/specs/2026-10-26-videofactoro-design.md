# videofactoro — Design Spec

- วันที่: 2026-10-26
- สถานะ: ร่างเพื่ออนุมัติ (ยังไม่มีโค้ด)
- ผู้ตัดสินใจ: Coke
- ที่มา: บทสนทนาออกแบบกับ Claude Code วันที่ 2026-10-26 + การอ่าน source ของ `genhaha/app` (cinematic, reference/keyframe), `genhaha/vids-gen-good` (motion, คลังภาพ), session Hermes `20261026_194319_9bce52` และ `20261026_212247_aa5b36` (คลิป Mochi) และเอกสาร Cloudflare Workers AI (ดึงเมื่อ 2026-10-26)

ป้ายในเอกสาร: **[Coke]** = Coke ตัดสินเองในบทสนทนา · **[ผู้ออกแบบ]** = Claude ตัดสินแทน Coke ตรวจและเปลี่ยนได้ · **[ต้องพิสูจน์]** = ข้อเท็จจริงที่ยังไม่ได้ทดสอบกับบัญชีจริง ต้องทำ spike ก่อนเขียนโค้ดส่วนนั้น

---

## 1. เจตนาและเหตุผล

Coke ต้องการ "โรงงานผลิตวิดีโอ AI" ที่ **agent ทำงานเองได้ทั้งหมด** ไม่ใช่ SaaS ที่ผู้ใช้ปรับค่าเองทุกอย่าง ผู้ใช้ทำแค่เรียก tool พร้อม prompt หนึ่งครั้ง ที่เหลือ agent (Claude Code ก่อน Hermes ทีหลัง) สั่ง tool ต่อจนได้ไฟล์วิดีโอ **[Coke]**

ปัญหาที่เคยเจอและเครื่องมือนี้ต้องแก้ (จาก session Hermes เรื่องคลิป Mochi):

1. **ตัวละครเพี้ยน:** ทุกฉากสร้างภาพตั้งต้นใหม่จาก prompt ไม่มีภาพอ้างอิงตัวเดิม ลายหาง สัดส่วน และเส้นเปลี่ยนไปทีละฉาก
2. **ดูเป็นสไลด์โชว์:** ภาพนิ่งซูมเข้าออก ตัวละครไม่ได้ขยับจริง
3. **ทำใหม่ทุกครั้ง:** Hermes เขียนสคริปต์ render ใหม่เองทุกรอบ (คลิป 60 วิใช้ตัวเรนเดอร์ Python ที่เขียนขึ้นใหม่ ไม่ผ่านขั้นตรวจ) ไม่มีเครื่องมือกลางที่ทำซ้ำได้
4. **ไม่มีขั้นตรวจอัตโนมัติ:** ต้องให้คนหรือ agent ดูภาพเอง

แนวคิดหลักคือ **project** เป็นแหล่งความจริงเดียวของเรื่อง โลก สไตล์ เสียง และตัวละคร ทุกคลิปที่ทำในภายหลังอ่านจาก project นี้ คลิปจึงต่อกันเป็นเรื่องเดียวกันได้ **[Coke]**

## 2. เป้าหมาย / ไม่ใช่เป้าหมาย / สิ่งที่ถือว่าล้มเหลว

**เป้าหมาย**

- G1 CLI หนึ่งตัว (`vf`) ที่ LLM agent เรียกได้ทุกขั้น ทุกคำสั่งตอบเป็น JSON ที่ agent อ่านต่อได้ ใช้ได้กับ agent ใดก็ได้ที่รันคำสั่ง shell ได้ **[Coke]**
- G2 ต้องสร้าง project ก่อนเสมอ คำสั่งสร้างวิดีโอทุกคำสั่งต้องมี project **[Coke]**
- G3 สร้างวิดีโอได้ 3 แบบจาก project: **คลิปสั้น** (≤20 วิ) · **คลิปยาว/cinematic** (ไม่จำกัดความยาว ช็อตละ ≤20 วิ) · **motion** (ตัวละครขยับด้วยโค้ด มีกราฟิกและข้อความ) **[Coke]**
- G4 เรียก AI ผ่าน **Cloudflare เท่านั้น** (Workers AI `@cf/*` และโมเดลภายนอกที่เรียกผ่าน Cloudflare `/ai/run`) **[Coke]**
- G5 ใช้ภาพที่สร้างแล้วซ้ำให้มากที่สุด (ตัวละคร ท่า ฉาก) เก็บไว้ใน project **[Coke]**
- G6 ตรวจคุณภาพอัตโนมัติด้วย decision model ของ Cloudflare (clef-omni) แล้วสร้างใหม่เมื่อไม่ผ่าน **[Coke เสนอให้พิจารณา, ผู้ออกแบบรับ]**
- G7 ทุกงานจบด้วยรายงานว่าใช้โมเดลอะไร กี่ครั้ง เท่าไร **[Coke]**
- G8 มี skill (markdown) สอน agent ใช้ tool **[Coke]**

**ไม่ใช่เป้าหมาย (รอบนี้)**

- หน้าเว็บ ระบบผู้ใช้ เครดิต การชำระเงิน แบบ SaaS **[Coke]**
- การเชื่อมกับ Hermes (ติดตั้งบน VPS, ส่งผ่าน LINE, อัปโหลด Drive) ทำหลังจากใช้กับ Claude Code ได้แล้ว **[Coke]** แต่ออกแบบให้ย้ายไป VPS ได้โดยไม่ต้องแก้สถาปัตยกรรม
- เพดานค่าใช้จ่ายต่อคลิป: ไม่มี **[Coke]**
- อัปโหลดขึ้น YouTube/TikTok อัตโนมัติ

**สิ่งที่ถือว่าล้มเหลวแม้จะรันผ่าน**

- ตัวละครตัวเดียวกันหน้าตาเปลี่ยนระหว่างช็อตหรือระหว่างคลิปจนคนดูจับได้
- คลิป motion ออกมาเป็นภาพนิ่งซูมเข้าออก (สไลด์โชว์)
- tool หยุดถามผู้ใช้กลางทาง หรือให้ผู้ใช้ตั้งค่าเอง
- จ่ายเงินซ้ำสำหรับช็อตหรือภาพที่สร้างสำเร็จแล้ว (เช่น รันใหม่หลังพังแล้วสร้างทุกช็อตใหม่)
- มีการเรียก AI ที่ไม่ผ่าน Cloudflare (OpenAI, ElevenLabs, Gemini โดยตรง ฯลฯ)
- คีย์หรือ token ไปโผล่ใน log, JSON output, รายงาน หรือ git

## 3. ข้อจำกัดและข้อเท็จจริงจากการสำรวจ

### 3.1 โมเดลที่ล็อกไว้

| งาน | โมเดล | เหตุผล / แหล่ง |
|---|---|---|
| สร้างวิดีโอ (ทุกโหมดที่ใช้วิดีโอ AI) | `black-forest-labs/flux-3-video` (`mode: i2v`) | **[Coke]** ให้ใช้ตัวเดียวทั้งหมด · 5–20 วิต่อครั้ง (จำนวนเต็ม) · 9:16 ได้ · `keyframes` 1–10 ภาพ แบบมีหรือไม่มีเวลา · มีเสียงในตัว (`generate_audio`) · `draft` ราคาถูกสำหรับพรีวิว · genhaha ใช้จริงใน production |
| สร้าง/แก้ภาพทุกชนิด (ภาพอ้างอิงตัวละคร ท่า ฉาก keyframe) | ~~`black-forest-labs/flux-3-image-klein`~~ → **`@cf/black-forest-labs/flux-2-klein-9b`** (2026-10-27 **[Coke]** เลือกทางไม่ใช้ R2: multipart `input_image_0..3`, `width`/`height`, $0.015 ต่อ MP แรก + $0.002 ต่อ MP ถัดไป + $0.002 ต่อ MP ภาพอ้างอิง · R2 เหลือใช้แค่ keyframe ของวิดีโอ) · ข้อความเดิม: | **[Coke]** "flux อันเดียวกันทั้งหมด" · ภาพอ้างอิง ≤10 ภาพ (`images: [uri]`) · `aspect_ratio` รวม 9:16 · `resolution` 768sq–4k · มี `seed` · ประมาณ $0.009 ต่อภาพ 1 MP ภาพอ้างอิงไม่คิดเงิน · genhaha cinematic ใช้อยู่ |
| ตรวจคุณภาพ (ภาพ, วิดีโอ, เสียง) | `@cf/cloudflare/clef-omni` | รับภาพ ≤4, วิดีโอ ≤2 คลิป (≤60 วิ, สุ่ม 2 fps, ได้ยินเสียงด้วย), เสียง ≤4 · ตอบเป็นความน่าจะเป็น (`noul`/`choice`/`score`) · $0.15 ต่อล้าน input token ไม่คิด output · vids-gen-good วัดได้ 27/28 ในชุดทดสอบภาพ |
| เขียนเรื่อง / storyboard / prompt (JSON) | `google/gemini-3.8-flash` ผ่าน Cloudflare, สำรอง `anthropic/claude-haiku-5.5` | **[ผู้ออกแบบ]** genhaha cinematic ผ่าน validator 10/10 ด้วย Gemini · ห้ามใช้โมเดลแบบ reasoning เป็นตัวเขียน JSON (ใช้ token หมดกับ reasoning แล้วตอบว่าง — บทเรียนจาก genhaha) |
| เสียงพากย์ | `google/gemini-3.8-flash-tts` | **[ผู้ออกแบบ]** อ่านไทยได้ (genhaha ใช้กับไทย), 30 เสียง, คืน WAV · ห้ามใส่คำสั่งอารมณ์ในข้อความ (โมเดลอ่านออกเสียง) · MeloTTS ที่ Hermes ใช้ฟังออกว่าสังเคราะห์และไม่มีไทย |
| จับเวลาคำสำหรับซับ | `@cf/openai/whisper-large-v3-turbo` (`word_timestamps`) | ราคาถูก, vids-gen-good ใช้อยู่ |
| เพลงประกอบ | `elevenlabs/music-v2` ผ่าน Cloudflare | `force_instrumental`, 3 วิ–10 นาที, $0.0025/วิ · ห้ามใส่ชื่อศิลปิน/เพลงใน prompt |
| ตัดพื้นหลังท่าตัวละคร (motion) | `bria/remove-background` ผ่าน Cloudflare | **[ผู้ออกแบบ]** vids-gen-good ใช้อยู่ **[ต้องพิสูจน์ รูป request]** |

ชื่อโมเดลทั้งหมดอยู่ในไฟล์ config เดียว (`src/models.js`) เปลี่ยนได้จุดเดียว แต่ค่าเริ่มต้นคือตารางนี้

### 3.2 ข้อเท็จจริงจาก Cloudflare ที่ส่งผลต่อการออกแบบ

1. **บิลสองทาง:** โมเดล `@cf/*` (clef-omni, whisper) ใช้ neurons (ฟรี 10,000/วัน) ส่วน `flux-3-*`, `gemini-*`, `elevenlabs/*`, `bria/*` เป็นโมเดลภายนอก **ต้องเติมเครดิต AI Gateway Unified Billing ไว้ก่อน** (ค่าธรรมเนียม 5% ตอนซื้อเครดิต) ยังเป็นบัญชี Cloudflare เดียว token เดียว
2. **รูป request สองแบบ:** `@cf/*` → `POST /accounts/{id}/ai/run/@cf/<model>` ส่ง input ที่ชั้นบนสุด · โมเดลภายนอก → `POST /accounts/{id}/ai/run` body `{"model": "...", "input": {...}}` (ใส่ชื่อโมเดลใน path จะได้ "No route for that URI")
3. **ส่งภาพเข้าโมเดลโดยไม่ใช้ที่ฝากไฟล์ (2026-10-27 **[Coke]** ตัด R2 ออกทั้งโปรเจกต์):** `flux-3-image-klein` รับแค่ URL (`images: format uri`, base64 ได้ 400) จึงเปลี่ยนภาพนิ่งไปใช้ `@cf/black-forest-labs/flux-2-klein-9b` ซึ่งแนบภาพอ้างอิงเป็น multipart `input_image_0..3` · `flux-3-video` รับ `keyframes` เป็น base64 ดิบ (ไม่มี `data:`) ได้ — ยิงจริงแล้วผ่าน (spikes/RESULTS.md §c) · ข้อความเดิม (ยกเลิก): ต้องเป็น HTTPS URL → ใช้ R2
4. **clef-omni รับ base64 เท่านั้น** ไม่รับ URL · สื่อรวม ≤16 MiB → ย่อวิดีโอเป็น 480p ก่อนส่ง
5. **`/ai/run` รอผลแบบ synchronous** ปกติวิดีโอใช้ 50–175 วิ · บางครั้งคืน request id แทน ต้อง poll `GET /accounts/{id}/ai/requests/{id}` (genhaha ใช้จริง) · ต้องเช็ก `state` แม้ HTTP 200 (`Failed` มากับ 200 ได้) · 500 "Request timed out" คือ timeout
6. **ห้ามเปิด retry ของ gateway** (`cf-aig-max-attempts`) — retry = สร้างและจ่ายคลิปใหม่
7. **content filter คือต้นทุนแฝงใหญ่สุด:** ใน genhaha 20.5% ของงานทั้งหมดโดนบล็อก สาเหตุอันดับหนึ่งคือชื่อที่มีลิขสิทธิ์ · ส่วนหนึ่งของ filter ทำงานหลังสร้างเสร็จ (~130 วิ) จึงอาจจ่ายเงินไปแล้ว → ต้องแก้ prompt ก่อนส่ง (§9.4)
8. **URL ผลลัพธ์หมดอายุ** (วิดีโอ ~2 ชม., ภาพ ~24 ชม.) → ดาวน์โหลดลง project ทันที
9. **flux-3-video ช็อตสั้นสุด 5 วิ** — ช็อตที่ storyboard อยากได้สั้นกว่านั้นต้องสร้าง 5 วิแล้วตัดตอน render
10. token ต้องมีสิทธิ์ **Workers AI Read + Edit** (เอกสารสองหน้าขัดกัน ให้ทั้งสองไว้ก่อน) · token บน VPS ตอนนี้ทดสอบแค่อ่านรายชื่อโมเดล ยังไม่ได้ทดสอบ `/ai/run` **[ต้องพิสูจน์]**

### 3.3 สภาพแวดล้อม

- **ภาษา:** ค่าเริ่มต้น `en` (ช่อง Shorts ตลาด US/UK ที่ Coke คุยกับ Hermes ไว้ — Claude เดา Coke ไม่ได้แก้) ตั้งเป็น `th` ได้ต่อ project · ไทยรองรับแบบ best-effort ในรอบแรก (ฟอนต์ไทยในซับ, อัตราอ่านไทยใน validator) ส่วนการจับเวลาคำไทยให้แม่นด้วยการเทียบกับข้อความต้นฉบับ (แบบ `align.mjs` ของ vids-gen-good) ทำเมื่อมี project ภาษาไทยจริง **[ผู้ออกแบบ]**
- รันบน Mac ของ Coke ก่อน (Claude Code) ต้องมี Node 22+, ffmpeg และ Chrome สำหรับ HyperFrames (โหลดเองตอนรันครั้งแรก) · VPS มี ffmpeg และ google-chrome อยู่แล้ว
- env ใช้ชื่อเดียวกับที่ตั้งไว้บน VPS แล้ว: `CLOUDFLARE_AI_ACCOUNT_ID`, `CLOUDFLARE_AI_API_TOKEN` (§12)

## 4. ภาพรวมสถาปัตยกรรม

```
agent (Claude Code / Hermes)
  │  อ่าน skills/videofactoro/SKILL.md, PROJECT.md, ผล JSON ของแต่ละคำสั่ง
  ▼
vf <command> ... --json           ← CLI (Node 22, ESM, ไม่มี build step)
  ├─ core/cf.js        เรียก Cloudflare ทั้งสองรูปแบบ, poll, ดาวน์โหลด, จัดประเภท error, บันทึก cost
  ├─ (core/r2.js ถูกตัดออก 2026-10-27 — ไม่ใช้ R2 แล้ว)
  ├─ core/cache.js     คลังภาพ/เสียงแบบ content-addressed ต่อ project
  ├─ core/qa.js        ด่านตรวจ clef-omni + วนสร้างใหม่ ≤2 ครั้ง
  ├─ core/state.js     สถานะต่อขั้น/ต่อช็อต → รันซ้ำแล้วทำต่อจากจุดค้าง
  ├─ core/llm.js       เรียก LLM แบบ JSON schema + validator + ส่งปัญหากลับให้แก้
  ├─ project/          create, character add, place add, pose add, show
  ├─ modes/clip.js     คลิปสั้น
  ├─ modes/film.js     คลิปยาว (cinematic)
  ├─ modes/motion/     motion (HyperFrames)
  └─ render/           ffmpeg: ต่อช็อต, ผสมเสียง, ซับ, poster
```

**Stack ตาม vids-gen-good** **[Coke ยืนยัน 2026-10-26]**:

- Node 22+ ไฟล์ `.mjs` (ESM, JavaScript ล้วน) **ไม่มี build step และไม่ต้อง `npm install`** — ใช้แค่ `node:` built-ins (`fetch`, `crypto`, `child_process`, `fs`, `util.parseArgs`) ตัวเซ็น R2 SigV4 จึงเขียนเองด้วย `node:crypto` ไม่ใช้ `aws4fetch`
- ffmpeg/ffprobe จากเครื่อง · HyperFrames ผ่าน `npx --yes hyperframes@0.8.153` (pin เวอร์ชัน, Chrome โหลดเองครั้งแรก)
- โครง repo แบบเดียวกัน: `tools/*.mjs` (หนึ่งไฟล์ต่องาน, รับ `--project` เป็นชื่อหรือ path) + `tools/lib.mjs` (ตัวเรียก Cloudflare, env, cost) + `templates/` + `docs/` (คู่มือไทย) + `skills/` · `tools/doctor.mjs` และ pre-commit `tools/check-secrets.mjs` ยกแนวมาจาก vids-gen-good
- `.env` ที่ git-ignore + `.env.example` · คีย์อ่านด้วย `loadEnv()` แบบ vids-gen-good
- ต่างจาก vids-gen-good จุดเดียว: มีทางเข้าเดียว `bin/vf.mjs` (เรียกว่า `vf`) ส่งต่อไปยัง `tools/*.mjs` และทุกคำสั่งตอบเป็น JSON ตาม §4.1 — เพื่อให้ agent ใดก็ได้ (รวม Hermes ที่รุ่นอ่อนกว่า) ใช้ได้โดยไม่ต้องรู้ชื่อสคริปต์ทั้งหมด · `node tools/<x>.mjs` ยังเรียกตรงได้

### 4.1 สัญญาของ CLI สำหรับ agent

- ทุกคำสั่งพิมพ์ **JSON หนึ่งก้อนลง stdout** ตอนจบ: `{ok, command, project, outputs:{...paths}, cost:{usd, calls}, warnings:[...], next:[คำสั่งที่แนะนำต่อ]}` ข้อความ progress ไปที่ stderr
- รหัสออก: `0` สำเร็จ · `2` ผู้เรียกใช้ผิด (argument, ไม่มี project) · `3` ตั้งค่า/สิทธิ์ผิด (env, token, เครดิตหมด) — agent ห้ามลองซ้ำ · `4` โดน content filter แม้แก้ prompt แล้ว · `5` ผู้ให้บริการล่ม/timeout หลังลองซ้ำครบ — agent รันคำสั่งเดิมซ้ำได้ (จะทำต่อจากจุดค้าง)
- ทุกคำสั่งที่เสียเงินรองรับ `--dry-run`: แสดงแผนการเรียก AI และราคาประเมินโดยไม่เรียกจริง
- **ทำซ้ำได้อย่างปลอดภัย (idempotent):** รันคำสั่งเดิมซ้ำจะใช้ผลที่สำเร็จแล้ว ไม่เรียกโมเดลซ้ำ เว้นแต่ใส่ `--force <ส่วน>`
- ไม่มีคำสั่งใดหยุดถามผู้ใช้ (no prompts, no TTY) **[Coke]** ทางเลือกทุกอย่างตัดสินโดย tool ตามกฎ หรือโดย agent ผ่าน argument
- **งานยาวรันเป็น job เบื้องหลัง** **[ผู้ออกแบบ]** เพราะวิดีโอหนึ่งครั้งใช้ 50–175 วิ คลิปเดียวอาจเกิน 10 นาทีที่ Claude Code ยอมให้คำสั่ง shell รัน และ film ยาวอาจใช้หลายชั่วโมง:
  - `vf clip|film|motion ...` (และ `project create`, `character add`) เริ่ม worker แบบ detached (process แยก, เขียน log ลง `clips/<id>/job.log`, lock file กันรันซ้อน) แล้ว **ตอบทันที** `{ok, job:{id, clip_dir, status:"running"}}`
  - `vf wait <job> [--timeout 540]` รอจนเสร็จหรือครบเวลา แล้วตอบสถานะล่าสุด (ความคืบหน้าต่อช็อต, ผลลัพธ์เมื่อเสร็จ) — skill สั่ง agent ให้เรียก `vf wait` วนจนได้ `status: done|failed`
  - `--foreground` รันในเทอร์มินัลตรงๆ (ใช้ตอน debug/ทดสอบ)
  - worker ไม่ตายตามเมื่อ agent ตัดคำสั่ง จึงไม่เสียคลิปที่จ่ายเงินแล้วกลางทาง (`/ai/run` แบบ synchronous ไม่ให้ request id จนกว่าจะเสร็จ) · worker ที่ตายจริง (เครื่องดับ) → รันคำสั่งเดิมซ้ำ = ทำต่อจาก state

### 4.2 คำสั่ง

| คำสั่ง | ทำอะไร |
|---|---|
| `vf setup` | ตรวจ env, ทดสอบ token กับ `/ai/run` หนึ่งครั้งราคาถูก, ตรวจเครดิตด้วยการเรียกโมเดลภายนอกที่ถูกที่สุด, ตรวจ ffmpeg/Node · ไม่พิมพ์ค่าคีย์ (ไม่มีขั้น R2 แล้ว) |
| `vf doctor` | เหมือน setup แต่อ่านอย่างเดียว ไม่สร้างอะไร |
| `vf project create --prompt "..." [--name slug] [--lang en] [--aspect 9:16]` | สร้าง project ทั้งชุดจาก prompt เดียว (§6.1) |
| `vf project show <p>` | สรุป project เป็น JSON (ตัวละคร, สถานที่, ท่าที่มี, ตอนที่ทำแล้ว, ยอดเงิน) ให้ agent อ่านเร็ว |
| `vf character add <p> --prompt "..."` | เพิ่มตัวละครใหม่เข้า project **[Coke: agent เพิ่มเองได้]** |
| `vf place add <p> --prompt "..."` | เพิ่มสถานที่ + ภาพฉาก |
| `vf pose add <p> <character> <pose> [--prompt "..."]` | เพิ่มท่าตัวละครสำหรับ motion |
| `vf asset find <p> <คำค้น...> [--kind pose\|place\|keyframe\|prop]` | ค้นคลังของ project |
| `vf clip <p> --prompt "..." [--duration 5-20]` | คลิปสั้น (§6.2) |
| `vf film <p> --prompt "..." --duration <วินาที>` | คลิปยาว (§6.3) — รันซ้ำเพื่อทำต่อ |
| `vf motion <p> --prompt "..." [--duration ...]` | motion (§6.4) มีคำสั่งย่อย `plan`, `assets`, `voice`, `snapshot`, `render` ให้ agent เข้าไปแก้ระหว่างทางได้ |
| `vf status <p> [<clip>]` | สถานะของคลิปที่กำลังทำ/ค้าง |
| `vf cost <p> [<clip>]` | สร้าง/พิมพ์รายงานต้นทุนใหม่ |

## 5. โครงสร้าง project บนดิสก์

ที่เก็บ: `$VF_PROJECTS` (ค่าเริ่มต้น `./projects/` ใน repo และอยู่ใน `.gitignore`) **[ผู้ออกแบบ]**

```
projects/<slug>/
  PROJECT.md            ← อ่านไฟล์นี้ก่อนเสมอ: เรื่อง โลก สไตล์ เสียง กฎ และ "แผนที่" ไฟล์ทั้งหมด
  project.json          ← ค่าที่เครื่องอ่าน: lang, aspect, style_prompt, palette, narrator_voice, music_mood, models, created_at
  EPISODES.md           ← ตอนที่ทำแล้ว (สร้างอัตโนมัติ): วันที่, โหมด, ชื่อ, เรื่องย่อ 1–2 บรรทัด, ตัวละครที่ใช้, ไฟล์
  characters/
    <id>/               เช่น cat, dog
      CHARACTER.md      รูปร่าง (look — ข้อความนี้ใส่ใน prompt ทุกครั้งแบบคำต่อคำ), นิสัย, เสียง (ชื่อเสียง TTS + คำบรรยายเสียง), ข้อห้าม
      character.json    {id, name, look, personality, voice:{tts_voice, description}, ref:"ref/main.png", sheet, poses:{...}}
      ref/main.png      ภาพอ้างอิงหลัก (ตัวเดียว เต็มตัว หน้าตรง พื้นเรียบ) — ภาพนี้ส่งเป็น reference ทุกครั้ง
      ref/sheet.png     ภาพหลายมุม (ถ้ามี) ใช้เป็น reference เสริม
      poses/<pose>.png  ท่าแบบตัดพื้นหลัง สำหรับ motion (rest, talk, talk_open, jump, surprised, ...)
  places/
    <id>/PLACE.md, place.json, plates/<variant>.jpg
  library/
    index.json          ← ดัชนีคลัง (§8)
    blobs/<sha256-12>.<ext>
  clips/
    <YYYYMMDD-HHMM>_<slug>/
      clip.json         โหมด, prompt ต้นฉบับ, ความยาว, ตัวละครที่ใช้
      state.json        สถานะทุกขั้น/ทุกช็อต (§9.1)
      storyboard.json   (film) / plan.json (clip) / script.json + scene/ (motion)
      shots/NN/         keyframe.png, video.mp4, last.png, qa.json
      audio/            tts, music, mix
      renders/<slug>-final.mp4, <slug>-final.srt, poster.jpg
      costs.jsonl
      SUMMARY.md
  costs.jsonl           ← ต้นทุนระดับ project (สร้างตัวละคร ฉาก ท่า)
```

**PROJECT.md** มีหัวข้อตายตัว เพื่อให้ agent และ LLM ใน tool อ่านส่วนเดียวกันได้ทุกครั้ง:

```
# <ชื่อเรื่อง>
## เรื่องย่อ (logline + premise)
## โลก (ที่ไหน ยุคไหน กฎของโลก)
## สไตล์ภาพ (style_prompt คำต่อคำ, ลายเส้น, แสง, ชุดสี 3–6 สี, สิ่งที่ห้าม เช่น ไม่มีตัวอักษรในภาพ ไม่ใช้โทนน้ำเงิน-ม่วง)
## เสียงและอารมณ์ (ผู้บรรยาย, โทนการเล่า, แนวเพลง)
## ตัวละคร (ตาราง: id | ชื่อ | บทบาท | ไฟล์)
## สถานที่ (ตาราง)
## กฎของเรื่อง (สิ่งที่ตัวละครทำ/ไม่ทำ, มุกประจำ, สิ่งที่ห้ามซ้ำ)
## แผนที่ไฟล์ (mapping: อะไรอยู่ไหน, คำสั่งที่ใช้เพิ่ม)
## ต้นทุนสะสม (อัปเดตอัตโนมัติ)
```

ส่วนที่ tool เขียนอัตโนมัติ (ตาราง, แผนที่ไฟล์, ต้นทุน) อยู่ระหว่าง marker `<!-- vf:auto:<name> -->` เพื่อให้ agent แก้ส่วนอื่นด้วยมือได้โดยไม่ถูกเขียนทับ **[ผู้ออกแบบ]**

## 6. Flow

### 6.1 สร้าง project (`vf project create`)

ผู้ใช้ให้ prompt เดียว ที่เหลือทำอัตโนมัติ ไม่ถามผู้ใช้ **[Coke]** ส่วนนี้เป็นภาพใหญ่ของเรื่องเท่านั้น ยังไม่เกี่ยวกับวิดีโอ **[Coke]**

1. **LLM เขียน bible** (JSON schema): ชื่อเรื่อง, logline, โลก, style_prompt, palette, โทนเสียง, แนวเพลง, ตัวละคร 1–6 ตัว (id, ชื่อ, `look` แบบละเอียด — สี ลาย สัดส่วน จุดเด่นที่ต้องคงที่ —, นิสัย, เสียง), สถานที่ 1–4 แห่ง, กฎของเรื่อง · ห้ามชื่อคนจริง แบรนด์ ตัวละครมีลิขสิทธิ์ (กัน content filter)
2. **ตรวจ bible ด้วย validator** (ฟิลด์ครบ, id ไม่ซ้ำ, look ยาวพอ) ไม่ผ่านส่งปัญหากลับให้ LLM แก้ ≤2 รอบ
3. **สร้างภาพอ้างอิงตัวละครทีละตัว** ด้วย klein: `look + style_prompt + "Character reference: single character, full body, front view, neutral pose, plain light background. No text."` สร้าง 3 แบบต่อตัว (seed ต่างกัน) **[ผู้ออกแบบ]**
4. **ให้ clef-omni เลือก** (§10): ให้คะแนนแต่ละแบบว่าตรงกับ `look` ไหม มีตัวเดียวไหม มีตัวอักษรไหม แล้วเลือกแบบที่ดีที่สุด — นี่คือจุดที่ "tool ต้องเลือกว่าจะเป็นแบบไหน" ซึ่ง Coke ตัดสินให้ agent/tool เลือกเองทั้งหมด **[Coke]** · แบบที่ไม่ได้เลือกเก็บไว้ใน `library/` (ไม่ลบ)
5. **สร้างภาพฉากของแต่ละสถานที่** หนึ่งภาพ (ไม่มีตัวละคร) ด้วย style เดียวกัน
6. เขียน `PROJECT.md`, `CHARACTER.md`, `PLACE.md`, json ทั้งหมด, บันทึกต้นทุน

**ผู้บรรยาย** **[ผู้ออกแบบ]**: bible กำหนด `narrator: on|off` + `narrator_voice` ใน project.json ตามแนวเรื่อง · แต่ละคำสั่งสร้างวิดีโอ override ได้ด้วย `--narrator` / `--no-narrator` · ใน film ถ้าเปิดผู้บรรยาย LLM เลือกต่อช็อตว่าใช้ `narr` หรือ `say` (ช็อตหนึ่งมีได้อย่างเดียว)

**สร้างตัวละครจากภาพที่มีอยู่** **[ผู้ออกแบบ]**: `vf project create` / `vf character add` รับ `--image <path>` (ซ้ำได้ต่อตัว) → ข้ามการสร้าง 3 แบบ ใช้ภาพนั้นเป็น `ref/main.png` (ตัดพื้น/ครอปถ้าจำเป็น) แล้วให้ LLM vision (gemini-3.8-flash ผ่าน Cloudflare) เขียน `look` จากภาพ · QA เหลือแค่ตรวจว่ามีตัวเดียวและไม่มีตัวอักษร — ใช้กับตัวละครเดิมอย่าง Mochi

`vf character add` / `vf place add` ทำขั้น 1 (เฉพาะตัวใหม่, โดยส่ง PROJECT.md เป็นบริบทเพื่อให้เข้ากับโลกและสไตล์เดิม) แล้ว 3–6 · ภาพอ้างอิงของตัวละครเดิมในฉากเดียวกัน (ถ้ามี) ส่งเป็น reference เพิ่มเพื่อให้สไตล์เข้ากัน

### 6.2 คลิปสั้น ≤20 วิ (`vf clip`) — ยึด Flow A ของ genhaha

ผู้ใช้/agent ให้ prompt คลิป ที่เหลืออัตโนมัติ **[Coke]**

1. **อ่าน project:** PROJECT.md, ตัวละครที่ prompt พูดถึง (จับจากชื่อ/id; ถ้าไม่ชัด LLM เลือกจากรายชื่อ), EPISODES.md
2. **LLM เขียนแผนคลิป** (JSON): `duration` (5–20), `characters[]`, `place`, `first_frame_prompt` (ภาพนิ่ง ไม่มี motion blur, ไม่มีตัวอักษร), `end_frame_prompt` (ทางเลือก — ภาพตอนการเปลี่ยนแปลงหลักเสร็จ), `video_prompt` (เขียนเป็นเส้นเวลา 2–3 จังหวะต่อ 5 วิ), `audio` (เสียงในฉาก; ถ้ามีบทพูด ใส่ใน video prompt แบบ genhaha) · ใช้กฎของ `referencePrompt.ts` และ `STORY_SYSTEM_PROMPT` ของ genhaha เป็นต้นแบบ (ภาพอ้างอิงเรียกว่า "Image N", ห้ามเติมตัวอักษร/โลโก้, ใช้แค่ตัวแบบจาก reference ไม่ใช่พื้นหลัง)
3. **สร้าง keyframe แรก** ด้วย klein: prompt + `look` ของทุกตัวในฉาก + style · references = `ref/main.png` ของตัวละครในฉาก (≤3) + ภาพฉากของสถานที่ (≤1) รวม ≤4 (genhaha: เกิน ~4 ภาพแล้วภาพผสมกัน)
4. **QA keyframe** (§10) → ไม่ผ่านสร้างใหม่ ≤2 ครั้ง
5. (ถ้ามี end frame) สร้าง end frame ด้วย references เดิม + keyframe แรก แล้ว QA
6. **สร้างวิดีโอ** flux-3-video `i2v`: `keyframes` = `"<url แรก>"` หรือ `["<แรก>", [t, "<ท้าย>"]]` โดย t = 75% ของความยาว (ค่าที่ genhaha ใช้จริง) · `aspect_ratio` จาก project · `resolution: hd` · `generate_audio: true`
7. **QA วิดีโอ** (§10) → ไม่ผ่านสร้างใหม่ ≤2 ครั้ง
   video prompt ใส่ "No background music." เสมอ เหมือน film **[Coke]**
8. **เสียงและเพลง:** ถ้าเปิดผู้บรรยาย ทำ TTS แล้วผสม · ผ่าน **music gate** เดียวกับ film (§6.3 ขั้น 6) ตัดสินว่าจะใส่เพลงไหม
9. **ผลลัพธ์:** `renders/<slug>-final.mp4`, poster, SUMMARY.md, แถวใหม่ใน EPISODES.md

### 6.3 คลิปยาว / cinematic (`vf film`) — ยึด cinematic ของ genhaha

input: prompt + ความยาวรวม (วินาที, ไม่จำกัด) **[Coke]** · ช็อตละ ≤20 วิ ต่อกันไปเรื่อยๆ **[Coke]** · agent/tool ตัดสินเองว่าจะแบ่งอย่างไร **[Coke]**

1. **โครงเรื่อง (outline):** LLM เขียนโครงทั้งคลิปเป็น "ช่วง" (act/sequence) ละประมาณ 30–90 วิ แต่ละช่วงมีเป้าหมายของเรื่องและตัวละครที่อยู่ในช่วง · ถ้าเรื่องต้องการตัวละคร/สถานที่ใหม่ outline ประกาศไว้ แล้ว tool เรียก `character add` / `place add` ให้ก่อนไปต่อ **[Coke: agent เพิ่มเองได้]**
2. **storyboard ทีละช่วง:** LLM แตกแต่ละช่วงเป็นช็อต โดยส่ง outline ทั้งหมด + สรุปช็อตท้ายของช่วงก่อนหน้า · schema ต่อช็อต (ต่อยอดจาก `boardSchema.ts` ของ genhaha):
   ```
   {id, dur: 5..20, text (บรรยายเรื่องในช็อต), characters:[id], place,
    framePrompt (EN, ภาพนิ่ง), videoPrompt (EN, เส้นเวลา),
    narr (คำที่ผู้บรรยายอ่าน, ภาษาตาม project) | say:{who, text},
    sfx, seam_in: "cut" | "cont"}
   ```
   validator: ผลรวมความยาว = ที่ขอ (±1 วิ), ทุก id อ้างถึงสิ่งที่มีจริง, คำบรรยายไม่ยาวเกินช่วง (≤ (dur−0.3) × อัตราอ่านของภาษา), ช็อตแรกของช่วงเป็น `cut` ได้เสมอ
   ช็อตที่เรื่องอยากให้สั้นกว่า 5 วิ: storyboard ระบุ `dur` จริง tool สร้าง 5 วิแล้วตัดตอน render **[ผู้ออกแบบ]**
3. **keyframe ต่อช็อต:** เหมือนคลิปสั้นขั้น 3–4 · ถ้า `seam_in = cont` → **ใช้เฟรมสุดท้ายจริงของวิดีโอช็อตก่อนหน้า** (ffmpeg ดึง `last.png`) เป็นเฟรมแรก แทนการสร้างภาพใหม่ ภาพจึงต่อกันจริง (genhaha ใช้ภาพที่วางแผนไว้ ซึ่งอาจไม่ตรงกับคลิปที่ออกมา) **[ผู้ออกแบบ]** · ช็อต `cont` จึงต้องรอช็อตก่อนหน้าเสร็จ ช็อต `cut` สร้าง keyframe ล่วงหน้าพร้อมกันได้
4. **วิดีโอต่อช็อต:** flux-3-video i2v, `generate_audio: true` · **บทพูดของตัวละคร (`say`) ให้โมเดลวิดีโอพูดเอง** ปากจึงขยับตรงเสียง **[Coke เลือก A]** — ต่อท้าย videoPrompt ด้วย `"<ชื่อ> (voice: <คำบรรยายเสียงจาก CHARACTER.md>) says in <ภาษา>: “…”."` ทุกครั้ง เพื่อให้เสียงตัวเดิมใกล้เคียงกันข้ามช็อต (คุมให้เป๊ะไม่ได้ — ยอมรับแล้ว) · ช็อตที่มีผู้บรรยาย (`narr`) ใส่ "No one speaks in this shot." · **ทุกช็อตใส่ "No background music."** คลิปที่สร้างจึงไม่มีเพลง **[Coke]** (เพลงตัดสินและใส่ตอนท้าย ขั้น 6)
5. **QA ต่อช็อต** (§10) และตรวจรอยต่อของคู่ช็อต `cont` (ส่งท้ายช็อตก่อน + ต้นช็อตหลังเข้า clef-omni ว่าต่อกันไหม)
6. **เสียง:**
   - TTS เฉพาะผู้บรรยาย (`narr`) ทีละบรรทัด ด้วย `narrator_voice` ของ project · อ่านความยาวจาก WAV · บทพูดตัวละครมาจากเสียงของวิดีโอแล้ว ไม่ทำ TTS ซ้ำ
   - **ด่านตัดสินเพลง (music gate)** **[Coke]**: หลังทุกช็อตเสร็จ ต่อคลิปแบบหยาบ (ไม่มีเพลง) แล้วให้ clef-omni ตัดสินว่าคลิปนี้ควรมีเพลงประกอบไหม และถ้ามี อารมณ์แบบไหน (§10 แถว music gate) · ถ้าใช่ → สร้างเพลงด้วย `elevenlabs/music-v2` ยาวเท่าคลิป (>10 นาที: ทำหลายท่อนแล้ว crossfade) โดย prompt จากอารมณ์ที่ clef เลือก + แนวเพลงใน PROJECT.md + เรื่องย่อ · ถ้าไม่ → ไม่มีเพลง (ไม่เสียเงิน) · agent override ได้ด้วย `--music on|off`
   - Whisper จับเวลาคำเพื่อทำซับ (ทั้งเสียงผู้บรรยายและบทพูดจากวิดีโอ)
7. **render** (port จาก `containers/render/cinematic.mjs` ของ genhaha มารันในเครื่อง): ปรับ fps/ขนาด/ตัดตอนแต่ละช็อต → ต่อแบบ hard cut → ผสมเสียง: เสียงในฉาก 100%, ผู้บรรยายเริ่มที่ต้นช็อต +300 ms (เร่งได้ไม่เกิน 1.15× ถ้าไม่พอดี), เพลง 60% ลด −12 dB ช่วงที่มีคนพูด, fade-out 1.5 วิ → x264 CRF 20, AAC 192k, faststart · ซับ: ไฟล์ `.srt` เสมอ และเวอร์ชันฝังซับ **[ผู้ออกแบบ: ฝังซับเป็นค่าเริ่มต้นสำหรับ Shorts]**
8. **ทำต่อได้:** ทุกช็อตเก็บสถานะใน `state.json` (§9.1) — `vf film <p> --resume <clip>` (หรือรันคำสั่งเดิมซ้ำ) ทำต่อจากช็อตที่ค้าง ไม่สร้างช็อตที่เสร็จแล้วซ้ำ **[ผู้ออกแบบ — จำเป็นเพราะไม่จำกัดความยาว]**

การทำงานพร้อมกัน: keyframe และวิดีโอของช็อต `cut` รันพร้อมกันได้สูงสุด 3 งาน (ค่าเริ่มต้น, ตั้งได้) **[ผู้ออกแบบ]**

### 6.4 Motion (`vf motion`) — ยึดแนวทาง vids-gen-good

ตัวละครขยับด้วยโค้ด มีกราฟิกและข้อความประกอบ **[Coke]** · ใช้ HyperFrames (HTML + GSAP เรนเดอร์ด้วย Chrome) ไม่ใช้ engine ของ huashu **[Coke ให้ยึด vids-gen-good; ผู้ออกแบบเลือก HyperFrames ตาม repo นั้น]** · pin เวอร์ชัน `hyperframes@0.8.153` เรียกผ่าน `npx --yes`

1. **`vf motion plan`** — LLM เขียน `script.json`: บรรทัดบท (ผู้พูด, ข้อความ, คำเน้น, อารมณ์), ฉากต่อบรรทัด (สถานที่, ตัวละครบนจอ, ท่าต่อจังหวะ, การเคลื่อนไหว เช่น เด้งเข้า วิ่งข้าม ตกใจกระโดด, กราฟิก เช่น ป้ายลำดับ คำเสียงตัวใหญ่ ลูกศร, SFX) · ใช้กฎจังหวะของ vids-gen-good (ภาพเปลี่ยนทุก 3–5 วิ ขั้นต่ำ 2.5 วิ, กราฟิกแรกภายใน 0.5 วิ, มีของใหม่ทุก 3 วิ, เขตปลอดภัยของข้อความ)
2. **`vf motion assets`** — หาในคลังก่อน สร้างเฉพาะที่ขาด (§8):
   - ท่าตัวละคร: klein + `ref/main.png` → ตัดพื้นหลัง (`bria/remove-background`) → QA ว่าเป็นตัวเดิม (§10) → เก็บใน `characters/<id>/poses/` ใช้ซ้ำทุกคลิป · ท่าพูดมีคู่ปิด/เปิดปาก (`talk`, `talk_open`) สำหรับสลับปากตามเสียง
   - ฉากหลัง: ใช้ `places/<id>/plates/` ก่อน ถ้าไม่มีมุม/อารมณ์ที่ต้องการ สร้างใหม่แล้วเก็บเข้า place นั้น
3. **`vf motion voice`** — TTS ต่อบรรทัด (cache ด้วย hash ของ ข้อความ+เสียง+โมเดล), ปรับความเร็ว, ต่อเป็นไฟล์เดียว, Whisper จับเวลาคำ → `timing.js` (เวลาบรรทัด, เวลาคำ, envelope ความดังสำหรับขยับปาก) · ความยาวแต่ละฉากตามเสียงจริง
4. **สร้างฉาก:** tool แปลง `script.json` + timing → `scene/index.html` ด้วย **motion kit** ของ repo (ตัวละคร sprite ที่ เด้ง/ยืดหด/เอียง/เดิน/วิ่ง/สลับท่า/สลับปาก, กราฟิก, ซับคาราโอเกะ, transition) โดยใช้ชุดสีของ project · **[ผู้ออกแบบ]** ค่าเริ่มต้นคือ tool สร้าง HTML จาก JSON (agent ที่อ่อนกว่าก็ได้คลิปที่ใช้ได้) และ agent แก้ `scene/index.html` เองได้เมื่ออยากได้มากกว่าที่ kit ทำ (ช่องทางหนีแบบ vids-gen-good) — กฎ HyperFrames จาก vids-gen-good ใส่ใน skill
5. **`vf motion snapshot`** — `hyperframes check` ต้อง 0 error · ถ่ายภาพที่ต้นทุกบรรทัด +0.6 วิ ทำ contact sheet · ส่ง contact sheet เข้า clef-omni ตรวจ (ข้อความถูกบัง/ล้นขอบ, ฉากว่าง, ตัวละครหลุดจอ) แล้วรายงานให้ agent · agent ดูเองแล้วแก้ ≥1 รอบตามที่ skill กำหนด
6. **`vf motion render`** — render 30 fps (ไม่มีเพลง) → music gate เดียวกับ film **[ผู้ออกแบบ: ใช้ด่านเดียวกันทุกโหมด]** → ผสมเพลง (ถ้ามี) + SFX → `-final.mp4`, `.srt`, poster, SUMMARY.md

`vf motion <p> --prompt ...` แบบไม่มีคำสั่งย่อย = รัน 1→6 ต่อกันอัตโนมัติ (ขั้น 5 ไม่หยุดรอ แต่ใส่คำเตือนใน output)

**SFX:** Cloudflare ไม่มีโมเดล SFX แยก **[ผู้ออกแบบ]** รอบแรกใช้เสียงสังเคราะห์ด้วยโค้ด (pop, whoosh, boing, ding — สร้างด้วย ffmpeg `aevalsrc`/ไฟล์ที่ generate ครั้งเดียวแล้วเก็บใน `assets/sfx/` ของ repo) · ทางเลือกภายหลัง: สร้างคลิปสั้นด้วย flux-3-video แล้วเอาแต่เสียง (แพง ไม่ทำรอบนี้)

## 7. โครงสร้างพื้นฐาน

### 7.1 ~~R2 สำหรับภาพอ้างอิงและ keyframe~~ — ยกเลิก 2026-10-27 **[Coke]**: ภาพนิ่งแนบ multipart, วิดีโอส่ง base64 ดิบ (ดู §3 ข้อ 3) · ข้อความเดิมเก็บไว้อ้างอิง:

- tool อัปโหลดไฟล์ไปที่ `tmp/<sha256>.<ext>` ใน bucket (ชื่อจาก `VF_R2_BUCKET`) แล้วสร้าง **presigned GET URL ที่ตั้งเวลาหมดอายุเองในโค้ด** (ค่าเริ่มต้น 2 ชั่วโมง, งานวิดีโอใช้ deadline ของงาน + 30 นาที) ไม่ต้องตั้งค่าใน console **[Coke ถาม, ยืนยัน]**
- ไฟล์ชื่อตาม hash → อัปโหลดซ้ำไม่ได้ทำงานซ้ำ (HEAD ก่อน)
- `vf setup` ตั้ง lifecycle rule ผ่าน API: ลบทุกอย่างใต้ `tmp/` ที่เก่ากว่า 1 วัน · ภาพตัวจริงอยู่ใน project บนดิสก์ R2 เป็นที่พักชั่วคราวเท่านั้น
- ใช้ S3 API ของ R2 (SigV4) — **[ผู้ออกแบบ]** เขียนตัวเซ็นเองด้วย `node:crypto` (ไม่กี่สิบบรรทัด) หรือใช้ `aws4fetch` ตัวเดียว เลี่ยง AWS SDK ทั้งก้อน
- ทำครั้งเดียวด้วยมือ: เปิดใช้ R2 ในบัญชี (**[ต้องพิสูจน์]** ว่ายังต้องกดใน dashboard) และสร้าง token ที่มีสิทธิ์ R2 Object Read & Write (+ bucket admin ถ้าให้ setup สร้าง bucket เอง) — Access Key ID/Secret ของ S3 แปลงจาก API token ได้ (Access Key ID = token id, Secret = SHA-256 ของค่า token) **[ต้องพิสูจน์]** ถ้าแปลงไม่ได้ ให้ตั้ง `VF_R2_ACCESS_KEY_ID` / `VF_R2_SECRET_ACCESS_KEY` ตรงๆ

### 7.2 ตัวเรียก Cloudflare (`core/cf.js`)

- ฟังก์ชันเดียว `run(model, input, opts)` เลือกรูป URL ตามชนิดโมเดล, multipart เมื่อโมเดลต้องการ, header `cf-aig-metadata` ใส่ `{project, clip, step}` (id อย่างเดียว ไม่ใส่ prompt) และ `cf-aig-gateway-id` ถ้าตั้ง `VF_AIG_GATEWAY_ID`
- รับผลได้ทั้ง base64, URL, `state`/`result` ซ้อนชั้น · ดาวน์โหลด URL ทันที
- poll ถ้าได้ request id (ทุก 5 วิ, timeout งานวิดีโอ 18 นาที — ค่าจาก genhaha)
- จัดประเภท error ตาม `classifyProviderError` ของ genhaha: moderation → `CONTENT_BLOCKED` · numeric code ของ CF · config (401/403/เครดิตหมด) → `CONFIG_ERROR` · timeout · busy/down
- นโยบายลองซ้ำ (ตาม genhaha): CONTENT_BLOCKED → แก้ prompt หนึ่งครั้ง (§9.4) · TIMEOUT 2 ครั้ง · BUSY/DOWN 3 ครั้ง (หน่วง 10/20/30 วิ) · CONFIG → หยุดทันที (exit 3)
- **ห้ามลองซ้ำงานที่จ่ายเงินแล้วถ้ายังไม่รู้ผล:** บันทึก request id ลง state ก่อนรอผล ถ้า process ตายแล้วรันใหม่ ให้ poll id เดิมก่อน
- ไม่เคยพิมพ์ token, ไม่ใส่ token ใน error message

## 8. คลังและ cache ภาพ (ต่อ project) **[Coke: ใช้ซ้ำให้มากที่สุด]**

ต่อยอดจาก vids-gen-good และปิดช่องโหว่ที่มันมี (cache แค่ "มีไฟล์ชื่อนี้แล้ว", ไม่มี cache ตาม prompt):

- **ชั้นที่ 1 — cache ตามเนื้อหา (ตรงทุกตัวอักษร):** key = sha256 ของ `{model, prompt ที่ส่งจริง, sha256 ของ reference แต่ละภาพเรียงลำดับ, aspect, resolution, seed}` · เจอ key เดิม = ใช้ไฟล์เดิม ไม่เรียกโมเดล ค่าใช้จ่าย 0 · ใช้กับภาพทุกชนิด, TTS (key = ข้อความ+เสียง+โมเดล+ความเร็ว), เพลง
- **ชั้นที่ 2 — คลังที่ค้นได้:** ทุกภาพที่สร้าง (รวมแบบที่ QA ไม่เลือก) ลง `library/index.json`:
  ```json
  {"id":"cat-pose-jump-01","kind":"pose","file":"characters/cat/poses/jump.png","blob":"library/blobs/ab12cd34ef56.png",
   "prompt":"<prompt จริง>","need":"<สิ่งที่ต้องการตอนสร้าง>","model":"black-forest-labs/flux-3-image-klein",
   "refs":["characters/cat/ref/main.png"],"characters":["cat"],"place":null,
   "tags":["jump","happy","indoor"],"tag_p":{"jump":0.93},"qa":{"identity":0.91,"has_text":0.02},
   "status":"selected|candidate|rejected","used_in":["clips/20261027-1010_cucumber"],"cost_usd":0.009,"created_at":"..."}
  ```
  tag ด้วย clef-omni ตอนเก็บ (คำศัพท์ tag ตายตัว + tag ตามตัวละคร/สถานที่ของ project) แบบ vids-gen-good · `vf asset find` ค้นด้วย tag/ตัวละคร/สถานที่/ข้อความ (ภาษาไทยแปลงเป็นอังกฤษด้วยพจนานุกรมสั้นๆ แบบ vids-gen-good)
- **กฎการใช้ซ้ำ:**
  - ท่าตัวละครและภาพฉาก (motion) → ค้นคลังก่อนเสมอ ถ้ามีที่ตรง (tag + clef-omni ตอบว่า "ใช้กับสิ่งที่ต้องการนี้ได้" ≥0.75) ใช้ซ้ำ ไม่สร้างใหม่
  - keyframe ของวิดีโอ AI → ปกติสร้างใหม่ (แต่ละช็อตต่างกัน) ยกเว้น cache ชั้นที่ 1 ตรง หรือ storyboard อ้างถึงภาพเดิมโดยตรง
  - ภาพอ้างอิงตัวละครหลัก (`ref/main.png`) ไม่เปลี่ยนเองโดยอัตโนมัติ เปลี่ยนได้ด้วย `vf character add --replace` เท่านั้น เพื่อไม่ให้ตัวละครทั้งเรื่องเปลี่ยน
- เก็บ `need` (สิ่งที่ต้องการตอนสร้าง) แยกจาก `prompt` เพื่อให้การค้นครั้งหลังเทียบกับความต้องการ ไม่ใช่ข้อความ prompt (บทเรียนจาก vids-gen-good ที่เคยเขียนทับ prompt แล้วค้นผิด)

## 9. ความทนทาน

### 9.1 state และการทำต่อ

`state.json` ต่อคลิป: ทุกขั้น/ทุกช็อตมี `status` (`pending|running|done|failed|skipped`), `request_id`, `result_url`, `file`, `attempts`, `qa`, `cost_usd` · เขียนแบบ atomic (เขียนไฟล์ชั่วคราวแล้ว rename) · รันซ้ำ: `done` ข้าม · `running` ที่มี `request_id` → poll ต่อ · `failed` → ลองใหม่ตามนโยบาย

### 9.2 QA ไม่ผ่านซ้ำ

สร้างใหม่ได้ไม่เกิน 2 ครั้งต่อชิ้น (ชิ้น = ภาพหนึ่งภาพ หรือช็อตหนึ่งช็อต) ถ้ายังไม่ผ่าน ใช้ชิ้นที่คะแนนดีที่สุด และเขียนคำเตือนลง output JSON และ SUMMARY.md **[ผู้ออกแบบ]** ตั้งได้ด้วย `--max-rerolls`

### 9.3 ความยาวและความเร็ว

ไม่มีเพดานค่าใช้จ่าย **[Coke]** แต่ `--dry-run` แสดงราคาประเมินก่อนเสมอ และ output ของ `film` บอกราคาประเมินทั้งคลิปตั้งแต่ขั้น storyboard

### 9.4 กัน content filter

ก่อนส่ง prompt ภาพ/วิดีโอ: ตรวจคำเสี่ยงแบบ keyword (ชื่อตัวละครมีลิขสิทธิ์, แบรนด์, คนดัง — ใช้รายการจาก `promptRisk.ts` ของ genhaha) แล้วให้ LLM เขียนใหม่ถ้าเจอ · ถ้าโดน `CONTENT_BLOCKED`: LLM เขียน prompt ใหม่หนึ่งครั้ง (กฎจาก `promptFix.ts`: แทนคนจริงด้วยบทบาท, แทนแบรนด์ด้วยคำทั่วไป, คงเรื่อง กล้อง เวลา) แล้วส่งใหม่ · ยังโดนอีก → ข้ามช็อตนั้นใน film (ใส่ช็อตแทนด้วย keyframe นิ่ง + Ken Burns) **[ผู้ออกแบบ]** และรายงาน; ใน clip → exit 4

## 10. ด่านตรวจคุณภาพด้วย clef-omni

ทุกด่านส่ง `state` (บริบทเป็นข้อความ: สิ่งที่ต้องการ, `look` ของตัวละคร) + `questions` + สื่อเป็น base64 (ภาพย่อด้านยาว 640px, วิดีโอย่อ 480p) · เกณฑ์ทั้งหมดอยู่ใน `src/qa-rules.js` และ **[ต้องพิสูจน์]** ค่าที่ใส่ไว้ต้องปรับด้วยชุดทดสอบจริงก่อนใช้ (§14)

| ด่าน | สื่อที่ส่ง | คำถาม (ประเภท) | ผ่านเมื่อ (ค่าเริ่มต้น) |
|---|---|---|---|
| ภาพอ้างอิงตัวละคร (เลือก 1 จาก 3) | ภาพ 3 แบบ | `matches_look` (noul ต่อภาพ), `single_character`, `has_text`, `full_body`, `quality` (score 1–5) | เลือกแบบที่ `matches_look` สูงสุด โดย `has_text < 0.3`, `single_character > 0.7` |
| keyframe | `ref/main.png` ของตัวละครในฉาก (≤3) + keyframe | `same_<id>` (noul: ตัวในภาพที่ 4 เป็นตัวเดียวกับภาพ N ไหม), `fits_shot`, `has_text`, `anatomy_ok` (ขา/หาง/ตาครบ ไม่เกิน) | ทุก `same_* ≥ 0.6`, `fits_shot ≥ 0.5`, `has_text < 0.3` |
| ท่าตัวละคร (motion) | ref + ท่า (หลังตัดพื้น) | `same_character`, `pose_is` (noul: ท่านี้คือ "<pose>" ไหม), `cutout_clean` | `same ≥ 0.7`, `pose_is ≥ 0.6` |
| วิดีโอช็อต | วิดีโอ 480p + ref ของตัวละครหลัก | `character_consistent` (ตัวละครหน้าตาคงเดิมตลอดคลิปและตรงกับภาพอ้างอิง), `no_morphing` (ไม่บิดเบี้ยว/แขนขางอก), `follows_prompt`, `unwanted_text`, `audio_ok` (ไม่มีเพลง ไม่มีเสียงพูดเมื่อสั่งว่าไม่มี) | `character_consistent ≥ 0.6`, `no_morphing ≥ 0.6`, `follows_prompt ≥ 0.5` |
| music gate (clip, film, motion) | คลิปหยาบไม่มีเพลง ย่อ 480p (≤60 วิ ส่งทั้งคลิป; ยาวกว่า ส่ง 2 ช่วงตัวแทน ≤60 วิ คือช่วงเปิดและช่วงพีกตาม outline) + `state` = เรื่องย่อ, แนวเพลงใน PROJECT.md | `needs_music` (noul), `mood` (choice: playful, tense, warm, epic, sad, mysterious, upbeat — ชุดตายตัว), `dialogue_heavy` (noul — ใช้กำหนดความดังเพลง) | `needs_music ≥ 0.5` → สร้างเพลงตาม `mood` · `dialogue_heavy ≥ 0.6` → เพลงเบาลง (40% แทน 60%) **[ผู้ออกแบบ: เกณฑ์และชุดอารมณ์]** |
| รอยต่อ `cont` | 2 ภาพ: ท้ายช็อตก่อน + ต้นช็อตหลัง | `continuous` | `≥ 0.6` (ไม่ผ่าน = คำเตือนเท่านั้น ไม่สร้างใหม่ — ต้นช็อตหลังมาจากท้ายช็อตก่อนอยู่แล้ว) |
| contact sheet (motion) | ภาพ sheet | `text_clipped`, `empty_frame`, `character_offscreen` | รายงานให้ agent ไม่บล็อก |

บันทึกผล QA ทุกครั้งลง `shots/NN/qa.json` และคลัง (`qa` ใน index) — ใช้ปรับเกณฑ์ภายหลัง · ข้อจำกัดที่รู้แล้ว: clef แจ้งผิดกับภาพเปรียบเปรย และนับจำนวนไม่เก่ง (vids-gen-good) → ไม่ถามเรื่องจำนวน

## 11. รายงานต้นทุน **[Coke: บอกว่าใช้อะไร เท่าไร]**

- `costs.jsonl` หนึ่งบรรทัดต่อการเรียกหนึ่งครั้ง: `{at, project, clip, step, model, units:{images|seconds|chars|tokens}, usd, estimated:true, attempt, outcome:"ok|qa_reject|blocked|error", cached:false}` · ใช้ซ้ำจากคลัง/cache = บรรทัด `usd: 0, cached: true`
- ราคาจากตาราง `src/pricing.js` (ราคาจากเอกสาร Cloudflare พร้อมวันที่ดึง) — ทุกยอดเป็น "ราคาประเมิน" · **[ต้องพิสูจน์]** flux-3-video คิดเงินต่อคลิปหรือต่อวินาที (genhaha บันทึกว่าต่อคลิป: hd $0.17, fhd $0.29, draft $0.06 — ยืนยันกับ gateway log ใน spike)
- `SUMMARY.md` ตอนจบทุกงาน:
  ```
  ## ต้นทุน (ประเมิน)
  | ขั้น | โมเดล | ครั้ง | หน่วย | USD |
  | storyboard | google/gemini-3.8-flash | 3 | 12.4k token | 0.012 |
  | keyframe | flux-3-image-klein | 9 (ผ่าน 7, สร้างใหม่ 2) | 9 ภาพ | 0.081 |
  | video | flux-3-video (hd) | 8 (สร้างใหม่ 1) | 7 ช็อต / 95 วิ | 1.36 |
  | qa | clef-omni | 17 | 41k token | 0.006 |
  | ...
  | ใช้ซ้ำจากคลัง | — | 5 ชิ้น | — | 0 |
  | รวม | | | | $1.52 (≈ 51 บาท) |
  ไม่รวม: ค่า LLM ของ agent ที่สั่ง tool (Claude/Hermes) — tool มองไม่เห็นค่านี้
  ```
  อัตราแลกเปลี่ยนจาก `VF_USD_THB` (ค่าเริ่มต้นใน config พร้อมวันที่)
- PROJECT.md ส่วน "ต้นทุนสะสม" อัปเดตทุกครั้ง (ค่าตั้ง project + ทุกคลิป)
- **ภายหลัง (ไม่ทำรอบแรก):** ดึงราคาจริงจาก AI Gateway (GraphQL `aiGatewayRequestsAdaptiveGroups`) มาเทียบ — ออกแบบ `cf-aig-metadata` ไว้รองรับแล้ว

## 12. ความลับและ env

| ชื่อ | จำเป็น | ใช้ทำ |
|---|---|---|
| `CLOUDFLARE_AI_ACCOUNT_ID` | ใช่ | account id (ชื่อเดียวกับที่ตั้งบน VPS แล้ว) |
| `CLOUDFLARE_AI_API_TOKEN` | ใช่ | Workers AI Read + Edit |
| `VF_AIG_GATEWAY_ID` | ไม่ | ระบุ gateway (ไม่ตั้ง = gateway ค่าเริ่มต้นของบัญชี) |
| `VF_PROJECTS`, `VF_USD_THB`, `VF_CONCURRENCY` | ไม่ | ค่าทั่วไป |

- อ่านจาก env ของ process ก่อน แล้วจาก `.env` ของ repo (git-ignored) · บน VPS ภายหลังใช้ `~hermes/.hermes/.env` + `docker_forward_env` ตามแนวเดิม
- ห้ามรับคีย์ทาง argument · ห้ามพิมพ์คีย์ (doctor แสดงแค่ "ตั้งแล้ว/ยาว N ตัว") · pre-commit hook ตรวจคีย์แบบ `check-secrets.mjs` ของ vids-gen-good
- ไม่ให้ผู้ใช้พิมพ์คีย์ในแชต — ให้สคริปต์ตั้งค่าที่รับแบบซ่อนตัวอักษรแบบ `set-cloudflare-ai-env.sh`

## 13. skill สำหรับ agent

`skills/videofactoro/SKILL.md` (+ `references/`) ติดตั้งให้ Claude Code ด้วยการ symlink เข้า `.claude/skills/` ของ repo (ใช้ได้เมื่อเปิด Claude Code ใน repo) และมีคำแนะนำติดตั้งแบบ global · Hermes ทำภายหลัง

เนื้อหา: เมื่อไรใช้ · กฎเหล็ก (สร้าง project ก่อนเสมอ, อ่าน PROJECT.md ก่อนทุกงาน, ไม่ถามผู้ใช้กลางทาง, ไม่ใส่ชื่อมีลิขสิทธิ์, รันซ้ำเมื่อ exit 5, หยุดเมื่อ exit 3) · ลำดับคำสั่งของแต่ละโหมด · วิธีเลือกโหมดจาก prompt ของผู้ใช้ (ไม่ระบุ: ≤20 วิ → clip, ยาวกว่า → film, คำว่า "การ์ตูนขยับ/กราฟิก/อธิบาย" → motion) **[ผู้ออกแบบ]** · วิธีอ่าน output JSON · ส่วน motion: กฎ HyperFrames (จาก `references/hyperframes.md` ของ vids-gen-good) และวิธีแก้ `scene/index.html` · การรายงานผลให้ผู้ใช้ (ไฟล์ + ต้นทุนจาก SUMMARY.md)

## 14. ลำดับการสร้างและ spike ที่ต้องทำก่อน

งานนี้คือ core หนึ่งชุด + 3 โหมด เสนอให้สร้างตามลำดับนี้ แต่ละขั้นใช้งานได้จริงก่อนขึ้นขั้นต่อไป **[ผู้ออกแบบ]**

0. **spike (ทิ้งได้) ยืนยันกับบัญชีจริง:** (a) token เรียก `/ai/run` ได้ และมีเครดิต Unified Billing · (b) R2 presigned URL ใช้เป็น `images` ของ klein และ `keyframes` ของ flux-3-video ได้ · (c) flux-3-video รับ base64 ดิบได้ไหม · (d) หน่วยราคา flux-3-video จาก gateway log · (e) รูป request ของ `bria/remove-background` · (f) clef-omni: ชุดทดสอบเล็ก (ภาพตัวละครเดิม/ไม่ใช่ 10 คู่, คลิปดี/เพี้ยน 6 คลิป) เพื่อตั้งเกณฑ์ §10 · (g) คุณภาพของการต่อช็อตด้วยเฟรมสุดท้าย
1. **core + project:** cf.js, r2.js, cache, cost, state, llm, `setup/doctor`, `project create`, `character/place add`, `project show` + skill ส่วนแรก
2. **คลิปสั้น** (`vf clip`) + QA keyframe/วิดีโอ + render เบื้องต้น
3. **คลิปยาว** (`vf film`) + TTS + เพลง + ซับ + render เต็ม + resume
4. **motion** (`vf motion`) + ท่าตัวละคร + motion kit + HyperFrames
5. **(ภายหลัง)** Hermes: ติดตั้งบน VPS, ส่งไฟล์ผ่าน LINE/Drive

การทดสอบ: unit test ด้วย fixture (ไม่เรียกเครือข่าย) สำหรับ validator, schema, keyframes payload, render plan, cost, cache key, state/resume (ยืม test ของ genhaha `tests/cinematic*.test.mjs` เป็นต้นแบบ) · `--dry-run` ทุกคำสั่ง · smoke test จริงหนึ่งงานต่อโหมดหลังจบแต่ละขั้น

## 15. สิ่งที่ปล่อยให้ผู้สร้างตัดสิน

- ชื่อไฟล์/โมดูลภายใน, ตัว parse argument (แนะนำ `node:util parseArgs` ไม่เพิ่ม dependency)
- prompt ภายในของ LLM ทุกตัว (ใช้ genhaha `STORY_SYSTEM_PROMPT`, `cinematic/prompts.ts`, `referencePrompt.ts` เป็นต้นแบบ) และรายละเอียด JSON schema ตราบที่มีฟิลด์ตาม §6
- ค่า tag vocabulary, พจนานุกรมไทย→อังกฤษ
- รายละเอียด motion kit (ชุด animation, กราฟิก) — เริ่มจาก `templates/shared/motion.js` ของ vids-gen-good
- รูปแบบ log บน stderr
