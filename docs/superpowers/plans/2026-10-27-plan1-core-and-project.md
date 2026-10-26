# videofactoro — แผน 1: core + spike + project

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ได้ CLI `vf` ที่ตั้งค่า/ตรวจระบบได้ สร้าง project (bible + ตัวละคร + สถานที่ พร้อมภาพอ้างอิงที่ clef-omni เลือก) จาก prompt เดียว เพิ่มตัวละคร/สถานที่ได้ และมี skill ส่วนแรกให้ agent ใช้ — พร้อมผล spike ที่ยืนยันกับบัญชี Cloudflare จริง

**Architecture:** Node 22 `.mjs` ไม่มี dependency · `bin/vf.mjs` เป็นทางเข้าเดียว ส่งต่อให้ `tools/<command>.mjs` ที่ export `main(args)` · โมดูล core (`env`, `out`, `cf`, `r2`, `cost`, `cache`, `state`, `jobs`, `llm`, `qa`, `images`) ใช้ร่วมกันทุกโหมด · งานยาวรันเป็น job เบื้องหลัง

**Tech Stack:** Node 22+ (`node:test`, `fetch`, `crypto`, `child_process`, `util.parseArgs`), ffmpeg/ffprobe, Cloudflare Workers AI `/ai/run`, R2 (S3 API SigV4)

**Spec:** `docs/superpowers/specs/2026-10-26-videofactoro-design.md` (อ่านคู่กันเสมอ — แผนนี้อ้างหมายเลขหัวข้อ §)

**แผนถัดไป (เขียนหลังแผนนี้จบ เพราะต้องใช้ผล spike):** แผน 2 คลิปสั้น · แผน 3 film · แผน 4 motion

## Global Constraints

- Node `>=22` · ESM `.mjs` เท่านั้น · **ห้ามเพิ่ม npm dependency** (`package.json` ไม่มี `dependencies`) · ไม่มี build step
- เรียก AI ผ่าน `https://api.cloudflare.com/client/v4/accounts/{id}/ai/run` เท่านั้น — `@cf/*` ใช้ `/ai/run/<model>` input ชั้นบนสุด · โมเดลอื่นใช้ `/ai/run` body `{model, input}`
- env: `CLOUDFLARE_AI_ACCOUNT_ID`, `CLOUDFLARE_AI_API_TOKEN`, `VF_R2_BUCKET`, (`VF_R2_TOKEN` | `VF_R2_ACCESS_KEY_ID`+`VF_R2_SECRET_ACCESS_KEY`), ทางเลือก `VF_AIG_GATEWAY_ID`, `VF_PROJECTS` (ค่าเริ่ม `<repo>/projects`), `VF_USD_THB` (ค่าเริ่ม `33.5`), `VF_CONCURRENCY` (ค่าเริ่ม `3`)
- ค่าใน env ที่เป็นความลับ **ห้ามปรากฏ** ใน stdout, stderr, log, ไฟล์ใดๆ ใน project, error message
- ทุกคำสั่งพิมพ์ JSON หนึ่งก้อนลง stdout · progress ลง stderr · exit: `0` ok · `2` USAGE · `3` CONFIG · `4` BLOCKED · `5` PROVIDER · `1` INTERNAL
- ไม่มีคำสั่งใดอ่าน stdin หรือถามผู้ใช้
- โมเดล (ไฟล์เดียว `tools/models.mjs`): image `black-forest-labs/flux-3-image-klein` · video `black-forest-labs/flux-3-video` · qa `@cf/cloudflare/clef-omni` · llm `["google/gemini-3.8-flash", "anthropic/claude-haiku-5.5"]` · tts `google/gemini-3.8-flash-tts` · asr `@cf/openai/whisper-large-v3-turbo` · music `elevenlabs/music-v2` · rmbg `bria/remove-background`
- ห้ามเปิด header `cf-aig-max-attempts` · `cf-aig-metadata` ใส่เฉพาะ id (`project`, `clip`, `step`) ไม่ใส่ prompt
- reroll ต่อชิ้นสูงสุด `2` (ค่าเริ่ม `--max-rerolls`)
- ภาพอ้างอิงส่งเข้า klein ได้สูงสุด 4 ภาพต่อครั้ง (spec §6.2 ข้อ 3)
- ทดสอบด้วย `node --test tests/` ไม่มีการเรียกเครือข่ายใน unit test (inject `fetch`)

## Review Focus

1. **ความลับรั่วผ่าน error:** fetch ล้มแล้ว error มี URL/headers/body ที่มี token → ต้อง redact ก่อนพิมพ์ (ทดสอบใน Task 2)
2. **รันซ้ำหลังพังกลางทาง:** `project create` ตายหลังสร้างตัวละครแรกเสร็จ → รันซ้ำต้องไม่สร้างตัวละครแรกใหม่ ไม่เสียเงินซ้ำ (ทดสอบใน Task 12)
3. **prompt มีชื่อลิขสิทธิ์** เช่น "Garfield กับ Snoopy" → bible ต้องออกมาเป็นตัวละครทั่วไป ไม่มีชื่อเหล่านั้นใน look/style (ทดสอบใน Task 12)
4. **prompt ภาษาไทยล้วน** → slug ต้องเป็น ASCII ที่ใช้ได้ (ไม่ใช่สตริงว่าง) และ id ตัวละครเป็น ASCII (ทดสอบใน Task 12)
5. **เรียก `vf` สองตัวพร้อมกันบน project เดียว** → ตัวที่สองต้องได้ USAGE error "job กำลังรัน" ไม่ใช่รันซ้อน (ทดสอบใน Task 7)

---

## File Structure

```
bin/vf.mjs                  ทางเข้า: parse command → import tools/<cmd>.mjs → emit/fail
tools/env.mjs               loadEnv, requireEnv, secretValues
tools/out.mjs               VfError, EXIT, emit, fail, log, redact
tools/args.mjs              parse(argv, spec) ห่อ util.parseArgs
tools/models.mjs            ชื่อโมเดลทั้งหมด
tools/cf.mjs                run, classify, withRetry, pollRequest, download, extractMedia, setFetch
tools/r2.mjs                presignUrl, r2Config, putObject, headObject, uploadTemp, ensureBucket, putLifecycle
tools/pricing.mjs           PRICES, estimate
tools/cost.mjs              logCost, readCosts, summarize, renderCostTable
tools/cache.mjs             sha256File, cacheKey, libLoad, libFindByKey, libAdd, libSearch, TH_WORDS
tools/state.mjs             writeJsonAtomic, readJson, openState
tools/jobs.mjs              startJob, jobStatus, waitJob
tools/llm.mjs               llmJson, buildInput, geminiStrip, anthropicStrip, readText
tools/qa.mjs                toQaImage, clef, pickBest, generateWithQa
tools/qa-rules.mjs          RULES.characterRef, RULES.placePlate
tools/images.mjs            generateImage
tools/risk.mjs              riskFindings (port จาก genhaha lib/promptRisk.ts)
tools/md.mjs                replaceAuto
tools/paths.mjs             projectsRoot, resolveProject, slugify, stamp
tools/setup.mjs             main (vf setup)
tools/doctor.mjs            main (vf doctor)
tools/project-create.mjs    main (vf project create)
tools/project-show.mjs      main (vf project show)
tools/character-add.mjs     main (vf character add)
tools/place-add.mjs         main (vf place add)
tools/asset-find.mjs        main (vf asset find)
tools/wait.mjs, tools/status.mjs   main (vf wait / vf status)
tools/bible.mjs             BIBLE_SCHEMA, CHARACTER_SCHEMA, validateBible, bibleSystemPrompt, writeProjectFiles
tools/check-secrets.mjs     pre-commit
spikes/                     สคริปต์ทิ้งได้ + RESULTS.md (Task 11)
skills/videofactoro/SKILL.md, skills/videofactoro/references/project.md
.claude/skills/videofactoro → ../../skills/videofactoro (symlink)
tests/*.test.mjs, tests/fixtures/*
```

---

### Task 1: Repo bootstrap, env, กันคีย์หลุด

**Files:**
- Create: `package.json`, `.gitignore`, `.env.example`, `README.md`, `tools/env.mjs`, `tools/check-secrets.mjs`, `tools/install-hooks.mjs`, `tests/env.test.mjs`

**Interfaces:**
- Produces: `loadEnv(startDir?: string): string|null` (path ของ `.env` ที่โหลด) · `requireEnv(names: string[]): Record<string,string>` (throw `VfError('CONFIG', 'ยังไม่ได้ตั้ง: A, B')` — บอกแค่ชื่อ) · `secretValues(): string[]` (ค่าของ env ทุกตัวที่ชื่อมี `TOKEN|SECRET|KEY|PASSWORD` และยาว ≥8)

- [ ] **Step 1:** `git init` ใน `/Users/coke/Projects/videofactoro`, branch `main` · `.gitignore`: `.env`, `projects/`, `node_modules/`, `spikes/out/`, `*.log`, `.DS_Store` · `package.json`: `{"name":"videofactoro","type":"module","private":true,"engines":{"node":">=22"},"bin":{"vf":"bin/vf.mjs"},"scripts":{"test":"node --test tests/"}}` · `.env.example` มีชื่อ env ทั้งหมดจาก Global Constraints (ค่าว่าง)
- [ ] **Step 2: เขียน test** `tests/env.test.mjs`:
  - `loadEnv ไม่ทับค่าที่มีอยู่แล้ว` — ตั้ง `process.env.X_TEST='a'`, `.env` ใน temp dir มี `X_TEST=b` → หลังโหลดยังเป็น `'a'`
  - `loadEnv ตัด quote` — `Y_TEST="v"` → `'v'`
  - `requireEnv บอกชื่อที่ขาดเท่านั้น` — error.code `'CONFIG'`, message มี `'Z_MISSING'`
  - `secretValues เก็บเฉพาะชื่อที่เป็นความลับ` — `FOO_TOKEN=abcdefgh123` อยู่, `FOO_NAME=abcdefgh123` ไม่อยู่
- [ ] **Step 3:** รัน `node --test tests/env.test.mjs` → FAIL (ไม่มีโมดูล)
- [ ] **Step 4:** เขียน `tools/env.mjs` — เดินหา `.env` จาก `startDir` ขึ้นไปจนเจอ แล้ว fallback ไป `.env` ที่ราก repo (แบบ `loadEnv` ใน `genhaha/vids-gen-good/tools/lib.mjs:60-80`)
- [ ] **Step 5:** รัน test → PASS
- [ ] **Step 6:** `tools/check-secrets.mjs` port จาก `genhaha/vids-gen-good/tools/check-secrets.mjs` (ตรวจไฟล์ staged ว่ามีค่าที่ดูเป็นคีย์หรือค่าจาก `.env` → exit 1 บอกแค่ชื่อไฟล์) · `tools/install-hooks.mjs` เขียน `.git/hooks/pre-commit` ที่เรียกมัน · รัน `node tools/install-hooks.mjs`
- [ ] **Step 7:** `README.md` สั้นๆ (ไทย): ติดตั้ง, `cp .env.example .env`, `node tools/install-hooks.mjs`, `vf doctor`
- [ ] **Step 8: Commit** `git add -A && git commit -m "chore: bootstrap repo, env loader, secret guard"`

### Task 2: สัญญา output และทางเข้า `vf`

**Files:**
- Create: `tools/out.mjs`, `tools/args.mjs`, `bin/vf.mjs`, `tools/models.mjs`, `tests/out.test.mjs`, `tests/vf.test.mjs`

**Interfaces:**
- Consumes: `secretValues()`
- Produces:
  - `class VfError extends Error { constructor(code: 'USAGE'|'CONFIG'|'BLOCKED'|'PROVIDER'|'INTERNAL', message: string, details?: object) }`
  - `EXIT = {USAGE:2, CONFIG:3, BLOCKED:4, PROVIDER:5, INTERNAL:1}`
  - `redact(text: string): string` — แทนทุกค่าใน `secretValues()` ด้วย `***`
  - `emit(result: object): void` — `stdout` หนึ่งบรรทัด `JSON.stringify({ok:true, ...result})` ผ่าน `redact`
  - `fail(err: unknown): never` — `{ok:false, error:{code, message, details}}` ผ่าน `redact`, exit ตาม `EXIT` (error ที่ไม่ใช่ `VfError` = INTERNAL)
  - `log(...parts): void` — stderr ผ่าน `redact`
  - `parse(argv: string[], options: object): {values, positionals}` — ห่อ `util.parseArgs` (`allowPositionals:true`, ผิดรูปแบบ → `VfError('USAGE')`)
  - ทุก `tools/<cmd>.mjs` ของคำสั่ง export `async function main(argv: string[]): Promise<object>`
  - `bin/vf.mjs`: map คำสั่ง → ไฟล์: `setup`, `doctor`, `project create`→`project-create.mjs`, `project show`→`project-show.mjs`, `character add`, `place add`, `asset find`, `wait`, `status`, `help` · คำสั่งไม่รู้จัก → USAGE พร้อมรายชื่อคำสั่ง
  - `MODELS` ใน `tools/models.mjs` ตามค่าใน Global Constraints: `{image, video, qa, llm:[...], tts, asr, music, rmbg}`

- [ ] **Step 1: test** `tests/out.test.mjs`:
  - `redact ลบค่า token` — ตั้ง `process.env.CLOUDFLARE_AI_API_TOKEN='tok_secret_123456'`, `redact('Bearer tok_secret_123456 failed')` → `'Bearer *** failed'`
  - `fail ให้ exit code ตาม code` — spawn `node -e` ที่ import `fail` แล้วโยน `new VfError('CONFIG','x')` → exit 3, stdout parse ได้ `{ok:false, error:{code:'CONFIG'}}`
  - `fail ของ error ทั่วไปเป็น INTERNAL` → exit 1
- [ ] **Step 2:** `tests/vf.test.mjs`: `vf help` exit 0 และ stdout มี `"commands"` · `vf nope` exit 2
- [ ] **Step 3:** รัน → FAIL
- [ ] **Step 4:** เขียนโมดูลตาม Interfaces · `bin/vf.mjs` เรียก `loadEnv()` ก่อน dispatch
- [ ] **Step 5:** รัน → PASS · `chmod +x bin/vf.mjs`
- [ ] **Step 6: Commit** `feat: vf entrypoint and JSON output contract`

### Task 3: ตัวเรียก Cloudflare (`tools/cf.mjs`)

**Files:**
- Create: `tools/cf.mjs`, `tests/cf.test.mjs`, `tests/fixtures/cf-*.json`

**Interfaces:**
- Consumes: `requireEnv`, `VfError`, `log`
- Produces:
  - `setFetch(fn): void` (สำหรับ test) · `setSleep(fn): void`
  - `isCfHosted(model: string): boolean` — `model.startsWith('@cf/')`
  - `run(model: string, input: object, opts?: {multipart?: boolean, meta?: {project?: string, clip?: string, step?: string}, timeoutMs?: number}): Promise<{result: any, ms: number}>` — คืน `result` ที่แกะชั้น `{success, result}` แล้ว และถ้ามี `state` ต้องเป็น `Completed` (ไม่ใช่ → throw ตาม classify) · ถ้าคืน request id แทนผล → `pollRequest`
  - `classify({status: number, body: string}): 'CONTENT_BLOCKED'|'CONFIG_ERROR'|'TIMEOUT'|'PROVIDER_BUSY'|'PROVIDER_DOWN'|'BAD_INPUT'`
  - `withRetry<T>(fn: () => Promise<T>): Promise<T>` — TIMEOUT ลองใหม่ 2 ครั้ง · BUSY/DOWN 3 ครั้ง หน่วง 10/20/30 วิ · CONTENT_BLOCKED → throw `VfError('BLOCKED')` · CONFIG_ERROR → `VfError('CONFIG')` · BAD_INPUT → `VfError('PROVIDER', …, {kind:'BAD_INPUT'})` ไม่ลองใหม่
  - `pollRequest(id: string, {intervalMs=5000, timeoutMs=18*60*1000}): Promise<any>` — `GET /accounts/{id}/ai/requests/{id}`
  - `extractMedia(result: any): {kind: 'url'|'base64', value: string, field: 'image'|'video'|'audio'}` — ลองตามลำดับ `result.image`, `result.result.image`, `result.video`, `result.result.video`, `result.audio`, `result.result.audio`; ตัด `data:...;base64,` ออก
  - `download(urlOrMedia: string|{kind,value}, file: string): Promise<string>`
- Headers: `Authorization: Bearer <CLOUDFLARE_AI_API_TOKEN>` · `cf-aig-metadata: JSON(meta)` เมื่อมี meta · `cf-aig-gateway-id` เมื่อมี `VF_AIG_GATEWAY_ID` · multipart เมื่อ `opts.multipart`

- [ ] **Step 1: test** (fetch จำลองที่บันทึก request ไว้):
  - `run โมเดลภายนอกยิง /ai/run พร้อม {model,input}` — URL ลงท้าย `/ai/run`, body.model `'black-forest-labs/flux-3-image-klein'`
  - `run โมเดล @cf ยิง /ai/run/@cf/...` — URL ลงท้าย `/ai/run/@cf/cloudflare/clef-omni`, body = input ตรงๆ
  - `HTTP 200 ที่ state Failed ถือว่าล้ม` — fixture `{success:true,result:{state:"Failed",error:"..."}}` → throw
  - `classify`: `{status:500, body:'Request timed out'}`→`TIMEOUT` · `{status:422, body:'moderation'}`→`CONTENT_BLOCKED` · `{status:400, body:'...safety...'}`→`CONTENT_BLOCKED` · `{status:401}`→`CONFIG_ERROR` · `{status:403}`→`CONFIG_ERROR` · `{status:429}`→`PROVIDER_BUSY` · `{status:503}`→`PROVIDER_DOWN` · `{status:400, body:'Bad input'}`→`BAD_INPUT` (ลำดับการตรวจ: moderation → config → timeout → status ตาม `classifyProviderError` ใน `genhaha/app/lib/errors.ts:244-280`)
  - `withRetry ลอง TIMEOUT 3 ครั้งรวม แล้วยอม` — fn ล้ม TIMEOUT ทุกครั้ง → เรียก 3 ครั้ง, throw `VfError('PROVIDER')`
  - `withRetry ไม่ลอง CONTENT_BLOCKED ซ้ำ` — เรียก 1 ครั้ง, code `'BLOCKED'`
  - `ไม่มีการส่ง cf-aig-max-attempts`
  - `extractMedia` จาก `{result:{image:"https://x"}}` และ `{image:"data:image/png;base64,AAA"}` → `{kind:'base64', value:'AAA'}`
- [ ] **Step 2:** รัน → FAIL
- [ ] **Step 3:** เขียน `tools/cf.mjs` ตาม Interfaces (กำหนด timeout ด้วย `AbortSignal.timeout`)
- [ ] **Step 4:** รัน → PASS
- [ ] **Step 5: Commit** `feat: Cloudflare /ai/run client with retry policy`

### Task 4: R2 ชั่วคราว (`tools/r2.mjs`)

**Files:**
- Create: `tools/r2.mjs`, `tests/r2.test.mjs`

**Interfaces:**
- Produces:
  - `presignUrl({method: 'GET'|'PUT'|'HEAD', host: string, path: string, region: string, accessKeyId: string, secretAccessKey: string, expiresSec: number, now: Date}): string` — SigV4 query-string presign, service `s3`, payload `UNSIGNED-PAYLOAD`
  - `r2Config(): Promise<{accountId, bucket, host, accessKeyId, secretAccessKey}>` — host `<accountId>.r2.cloudflarestorage.com`, region `auto` · ถ้ามี `VF_R2_ACCESS_KEY_ID`/`VF_R2_SECRET_ACCESS_KEY` ใช้ตรงๆ · ไม่มีแต่มี `VF_R2_TOKEN` → `accessKeyId` = id จาก `GET https://api.cloudflare.com/client/v4/user/tokens/verify` (Bearer `VF_R2_TOKEN`), `secretAccessKey` = sha256 hex ของค่า token **[spike b ยืนยัน]**
  - `putObject(key: string, bytes: Buffer, contentType: string): Promise<void>` · `headObject(key): Promise<boolean>`
  - `uploadTemp(file: string, {expiresSec = 7200} = {}): Promise<string>` — key `tmp/<sha256 ของไฟล์>.<ext>`; `headObject` ก่อน มีแล้วไม่อัปโหลดซ้ำ; คืน presigned GET URL
  - `ensureBucket(): Promise<'exists'|'created'>` · `putLifecycle({prefix: 'tmp/', days: 1}): Promise<void>` (S3 `PUT ?lifecycle`, XML `<Expiration><Days>1</Days></Expiration>` + `Content-MD5`)

- [ ] **Step 1: test** `presign ตรงกับตัวอย่างของ AWS` — ตัวอย่างจากเอกสาร AWS "Authenticating Requests: Using Query Parameters":
  ```js
  presignUrl({method:'GET', host:'examplebucket.s3.amazonaws.com', path:'/test.txt', region:'us-east-1',
    accessKeyId:'AKIAIOSFODNN7EXAMPLE', secretAccessKey:'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    expiresSec:86400, now:new Date('2013-05-24T00:00:00Z')})
  // ต้องลงท้าย &X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404
  ```
  และ `uploadTemp ไม่อัปโหลดซ้ำเมื่อ head เจอ` (fetch จำลอง: HEAD 200 → ไม่มี PUT)
- [ ] **Step 2:** รัน → FAIL
- [ ] **Step 3:** เขียนด้วย `node:crypto` (HMAC-SHA256, canonical request ตาม SigV4) — ใช้ฟังก์ชันเซ็นเดียวกันสำหรับ request ตรง (PUT/HEAD/lifecycle) โดยส่งเป็น presigned URL อายุ 60 วิ
- [ ] **Step 4:** รัน → PASS
- [ ] **Step 5: Commit** `feat: R2 presign and temp upload`

### Task 5: ราคาและบันทึกต้นทุน

**Files:**
- Create: `tools/pricing.mjs`, `tools/cost.mjs`, `tests/cost.test.mjs`

**Interfaces:**
- Produces:
  - `PRICES` (มี `asOf: '2026-10-26'` และแหล่งต่อรายการ):
    `flux-3-image-klein`: `{firstMp: 0.009, extraMp: 0.0017}` · `flux-3-video`: `{hd: 0.17, fhd: 0.29, draft: 0.06, unit: 'clip', verified: false}` · `clef-omni`: `{inPerM: 0.15}` · `gemini-3.8-flash`: `{inPerM: 0.75, outPerM: 3.75}` · `claude-haiku-5.5`: `{inPerM: 0.1, outPerM: 0.5, verified: false}` · `gemini-3.8-flash-tts`: `{perMin: 0.014, verified: false}` · `music-v2`: `{perSec: 0.0025}` · `whisper-large-v3-turbo`: `{perMin: 0.0005}` · `bria/remove-background`: `null` (ไม่ทราบ)
  - `estimate(model: string, units: {images?, mp?, clips?, quality?, tokensIn?, tokensOut?, seconds?, minutes?}): number|null`
  - `logCost(dir: string, entry: {project, clip?, step, model, units, usd: number|null, attempt?: number, outcome: 'ok'|'qa_reject'|'blocked'|'error', cached?: boolean}): void` — เติม `at` (ISO) และ `estimated: true` แล้ว append `costs.jsonl`
  - `readCosts(dir): object[]`
  - `summarize(entries): {rows: {step, model, calls, ok, rerolls, units, usd}[], totalUsd: number, cachedCount: number, unknownPriceModels: string[]}`
  - `renderCostTable(summary, usdThb: number): string` — Markdown ตามตัวอย่างใน spec §11 รวมบรรทัด "ไม่รวม: ค่า LLM ของ agent ที่สั่ง tool (Claude/Hermes) — tool มองไม่เห็นค่านี้"

- [ ] **Step 1: test:**
  - `estimate klein 1MP = 0.009` · `estimate klein 1.5MP ≈ 0.00985`
  - `estimate video hd 1 คลิป = 0.17`
  - `summarize นับ reroll` — 3 บรรทัด keyframe (ok, qa_reject, ok) → `calls:3, ok:2, rerolls:1`
  - `summarize นับรายการ cached แยก และ usd null ไม่รวมในยอด แต่ชื่อโมเดลอยู่ใน unknownPriceModels`
  - `renderCostTable มียอดบาท` — total 1.5, usdThb 33.5 → มี `'≈ 50 บาท'` (ปัดเป็นจำนวนเต็ม)
- [ ] **Step 2–4:** FAIL → เขียน → PASS
- [ ] **Step 5: Commit** `feat: pricing table and cost ledger`

### Task 6: cache และคลังของ project

**Files:**
- Create: `tools/cache.mjs`, `tools/state.mjs` (เฉพาะ `writeJsonAtomic`, `readJson`), `tests/cache.test.mjs`

**Interfaces:**
- Produces:
  - `writeJsonAtomic(file, obj): void` (เขียน `file.tmp-<pid>` แล้ว `renameSync`) · `readJson(file, fallback)`
  - `sha256File(file): string` (hex)
  - `cacheKey({model, prompt, refs: string[] /* path */, aspect?, resolution?, seed?}): string` — sha256 ของ JSON ที่มี `refs` แปลงเป็น `sha256File` **คงลำดับ**
  - `libLoad(projectDir): {entries: Entry[]}` (ไม่มีไฟล์ → `{entries: []}`) — ไฟล์ `library/index.json`
  - `libFindByKey(lib, key): Entry|undefined`
  - `libAdd(projectDir, entry: Omit<Entry,'blob'|'created_at'> & {key: string}, bytes: Buffer, ext: string): Entry` — เขียน `library/blobs/<sha256(bytes) 12 ตัวแรก>.<ext>` แล้วบันทึก index (atomic)
  - `libUpdate(projectDir, id, patch): Entry`
  - `libSearch(lib, terms: string[], {kind?, character?, place?, status?}): {entry, score}[]` — แปลงคำไทยผ่าน `TH_WORDS` ก่อน · คะแนน: tag ตรง +3, `tag_p` +3×p, ส่วนหนึ่งของ tag +1.5, คำอยู่ใน `need` +1, `status==='rejected'` −2 · เรียงจากมากไปน้อย ตัดคะแนน 0
  - `TH_WORDS`: อย่างน้อย `หมา:dog, แมว:cat, หนู:mouse, กระโดด:jump, วิ่ง:run, นั่ง:sit, ตกใจ:surprised, หัวเราะ:laugh, ร้องไห้:cry, โกรธ:angry, ดีใจ:happy, เศร้า:sad, ห้อง:room, บ้าน:house, ครัว:kitchen, สวน:garden, กลางคืน:night, ฝน:rain, ทะเล:sea, ป่า:forest`
  - `Entry` = รูปใน spec §8 (`id, kind, file, blob, key, prompt, need, model, refs, characters, place, tags, tag_p, qa, status, used_in, cost_usd, created_at`)

- [ ] **Step 1: test:**
  - `cacheKey เปลี่ยนเมื่อเนื้อไฟล์ ref เปลี่ยน แม้ path เดิม`
  - `cacheKey เปลี่ยนเมื่อลำดับ ref เปลี่ยน`
  - `libAdd แล้ว libFindByKey เจอ และไฟล์ blob มีอยู่จริง`
  - `libSearch คำไทย แมว กระโดด เจอ entry ที่ tags มี cat, jump ก่อน entry ที่มีแค่ cat`
  - `libSearch ลดคะแนน rejected`
  - `writeJsonAtomic ไม่ทิ้งไฟล์ .tmp`
- [ ] **Step 2–4:** FAIL → เขียน → PASS
- [ ] **Step 5: Commit** `feat: content-addressed cache and project library`

### Task 7: state และ job เบื้องหลัง

**Files:**
- Modify: `tools/state.mjs` (เพิ่ม `openState`)
- Create: `tools/jobs.mjs`, `tools/wait.mjs`, `tools/status.mjs`, `tests/jobs.test.mjs`, `tests/fixtures/fake-cmd.mjs`

**Interfaces:**
- Produces:
  - `openState(dir): {get(id): Step|undefined, set(id, patch): Step, all(): Record<string,Step>}` — `Step = {status: 'pending'|'running'|'done'|'failed'|'skipped', attempts?: number, request_id?: string, file?: string, output?: any, qa?: any, cost_usd?: number, error?: string, updated_at}` · ทุก `set` เขียน `state.json` แบบ atomic
  - `async step(state, id, fn: () => Promise<any>): Promise<any>` — `done` → คืน `output` เดิมโดยไม่เรียก `fn`; ไม่งั้นตั้ง `running` → รัน → `done` + `output` หรือ `failed` + `error` แล้ว throw ต่อ
  - `startJob({jobRoot: string, command: string[], label: string}): {id, dir, status: 'running', pid}` — `jobRoot` = `<project>/.jobs` · ถ้ามี job ใน `jobRoot` ที่ `status==='running'` และ pid ยังอยู่ (`process.kill(pid, 0)`) → `VfError('USAGE', 'มี job กำลังรันอยู่ใน project นี้: <id>')` · spawn `process.execPath bin/vf.mjs ...command --foreground --job-dir <dir>` แบบ `detached:true`, stdout/stderr → `<dir>/job.log`, `unref()` · เขียน `<dir>/job.json` `{id, pid, command, label, status:'running', started_at}`
  - ฝั่ง worker: `bin/vf.mjs` เมื่อเห็น `--job-dir` ให้เขียนผล `emit`/`fail` ลง `<dir>/job.json` (`status: 'done'|'failed'`, `result`, `finished_at`) ด้วย
  - `jobStatus(dir): {id, status: 'running'|'done'|'failed', result?, error?, log_tail: string[]}` — pid ตายแต่ยัง `running` → `failed` + error `'worker หยุดกลางทาง — รันคำสั่งเดิมซ้ำเพื่อทำต่อ'` · `log_tail` = 20 บรรทัดสุดท้ายของ log
  - `waitJob(dir, timeoutSec = 540): Promise<jobStatus>` — poll ทุก 2 วิ
  - `vf wait <project> [<job-id>] [--timeout 540]` (ไม่ใส่ id = job ล่าสุด) · `vf status <project>` = รายการ job ล่าสุด 10 อัน
  - convention สำหรับคำสั่งที่ใช้เวลานาน: `main(argv)` ตรวจ `--foreground`; ไม่มี → `startJob` แล้วคืน `{job}` ทันที

- [ ] **Step 1: test:**
  - `step ข้ามขั้นที่ done แล้ว` — fn นับครั้ง, เรียก step สองรอบ (สร้าง openState ใหม่ระหว่างรอบ) → fn ถูกเรียก 1 ครั้ง
  - `step ที่ล้มบันทึก failed และ attempts`
  - `startJob รันจนเสร็จและ waitJob ได้ done` — ใช้ `tests/fixtures/fake-cmd.mjs` (คำสั่งจำลองที่ sleep 1 วิแล้ว emit `{x:1}`; ให้ `startJob` รับ `entry` override สำหรับ test)
  - **(Review Focus 5)** `startJob ตัวที่สองบน jobRoot เดียวกันระหว่างตัวแรกยังรัน ได้ USAGE`
  - `jobStatus ของ pid ที่ตายแล้วเป็น failed พร้อมข้อความให้รันซ้ำ`
- [ ] **Step 2–4:** FAIL → เขียน → PASS
- [ ] **Step 5: Commit** `feat: resumable state and detached jobs`

### Task 8: LLM แบบ JSON (`tools/llm.mjs`)

**Files:**
- Create: `tools/llm.mjs`, `tests/llm.test.mjs`

**Interfaces:**
- Consumes: `run`, `withRetry`, `MODELS.llm`, `logCost`, `estimate`
- Produces:
  - `buildInput(model, {system, messages: {role:'user'|'assistant', content: string}[], schema, maxTokens, images?: string[] /* data URI */}): object` — ยกจาก `genhaha/app/lib/cinematic/llm.server.ts` `inputFor`: gemini → `{contents, systemInstruction, generationConfig:{responseMimeType:'application/json', responseSchema: geminiStrip(schema), maxOutputTokens}}` (ภาพเป็น `inlineData` ใน parts ของข้อความ user แรก) · anthropic → `{system, messages, max_tokens, output_config:{format:{type:'json_schema', schema: anthropicStrip(schema)}}}` (ภาพเป็น content block `image` base64; **ห้ามส่ง temperature/top_p**)
  - `geminiStrip(schema)` ลบ `additionalProperties` ทุกชั้นและ `enum` ของ integer · `anthropicStrip(schema)` ลบ `minItems`/`maxItems` ทุกชั้น (อ้างอิง `genhaha/app/lib/cinematic/boardSchema.ts:58,80`)
  - `readText(model, result): {text, usage: {in, out}}` — gemini `candidates[0].content.parts[].text` · anthropic `content[type=text].text` (อ้างอิง `llmText.ts:37-56`)
  - `llmJson({system, user, schema, validate?: (obj) => string[], images?, maxTokens = 8000, meta, costDir}): Promise<{data, model, usage}>` — ต่อโมเดลใน `MODELS.llm` ได้ 2 รอบ; รอบสองส่ง assistant ข้อความเดิม + user `"แก้ปัญหาเหล่านี้แล้วตอบ JSON ใหม่ทั้งก้อน:\n- ..."`; parse ไม่ได้นับเป็น issue · ครบทุกโมเดลแล้วยังไม่ผ่าน → `VfError('PROVIDER', 'LLM ตอบไม่ผ่าน validator', {issues})` · บันทึก cost ทุกครั้ง

- [ ] **Step 1: test** (fetch จำลอง):
  - `gemini input ไม่มี additionalProperties` · `anthropic input ไม่มี minItems และไม่มี temperature`
  - `llmJson ส่ง issues กลับไปรอบสอง` — รอบแรกตอบ `{"a":1}` validate คืน `['ขาด b']` รอบสองตอบ `{"a":1,"b":2}` → data มี b, body ของ request ที่ 2 มีข้อความ `ขาด b`
  - `llmJson ข้ามไปโมเดลสำรองเมื่อโมเดลแรกผ่านไม่ได้ 2 รอบ` — request ที่ 3 มี `model:'anthropic/claude-haiku-5.5'`
  - `llmJson บันทึก cost ทุก request`
- [ ] **Step 2–4:** FAIL → เขียน → PASS
- [ ] **Step 5: Commit** `feat: JSON LLM client with validator feedback and fallback`

### Task 9: QA ด้วย clef-omni และการเลือก/สร้างใหม่

**Files:**
- Create: `tools/qa.mjs`, `tools/qa-rules.mjs`, `tests/qa.test.mjs`

**Interfaces:**
- Consumes: `run`, `MODELS.qa`, `logCost`
- Produces:
  - `toQaImage(file): Promise<string>` — ffmpeg ย่อด้านยาว 640px เป็น JPEG แล้วคืน data URI
  - `clef({state: string|object, questions: Record<string, object>, images?: string[], videos?: string[], audio?: string[], meta, costDir}): Promise<Record<string, any>>` — body `{model:'clef-omni', state, questions, images}` ไปที่ `@cf/cloudflare/clef-omni` · คืน `answers` · images > 4 → `VfError('INTERNAL')`
  - `RULES.characterRef = {questions(ctx: {look, style}): object, judge(answers): {pass: boolean, score: number, reasons: string[]}}` — คำถามต่อภาพ (ส่งทีละภาพ): `matches_look` noul ("Does this image show this character: <look>?"), `single_character` noul, `has_text` noul, `full_body` noul · pass: `matches_look ≥ 0.5 && single_character ≥ 0.7 && has_text < 0.3` · score = `matches_look + 0.2*full_body − has_text`
  - `RULES.placePlate` — `fits` noul ("Is this the place: <desc>, in style <style>?"), `has_text`, `has_people_or_animals` · pass: `fits ≥ 0.5 && has_text < 0.3 && has_people_or_animals < 0.5`
  - ค่าเกณฑ์ทั้งหมดเป็น constant ด้านบนไฟล์ `qa-rules.mjs` (ปรับหลัง spike f)
  - `pickBest(candidates: {file, ...}[], rule, ctx, {meta, costDir}): Promise<{best, ranked: {candidate, verdict}[]}>` — ตรวจทีละภาพ, เลือก pass ที่ score สูงสุด; ไม่มี pass → score สูงสุด + `best.warning`
  - `generateWithQa({generate: (attempt: number) => Promise<Candidate>, check: (c) => Promise<Verdict>, maxRerolls = 2}): Promise<{best: Candidate, verdict: Verdict, attempts: {candidate, verdict}[], passed: boolean}>`

- [ ] **Step 1: test:**
  - `clef body ใช้ model clef-omni และ images เป็น data URI`
  - `characterRef.judge ไม่ผ่านเมื่อ has_text 0.6`
  - `pickBest เลือกภาพที่ score สูงสุดในกลุ่มที่ผ่าน` (clef จำลองคืนคำตอบต่างกันต่อภาพ)
  - `pickBest ไม่มีภาพผ่าน คืนภาพคะแนนสูงสุดพร้อม warning`
  - `generateWithQa หยุดเมื่อผ่าน` (ผ่านรอบ 2 → generate ถูกเรียก 2 ครั้ง) · `generateWithQa สร้างไม่เกิน 1+2 ครั้ง แล้วคืนตัวดีที่สุด passed:false`
- [ ] **Step 2–4:** FAIL → เขียน (toQaImage ทดสอบกับภาพ PNG เล็กใน `tests/fixtures/`) → PASS
- [ ] **Step 5: Commit** `feat: clef-omni QA gates, pick-best and reroll loop`

### Task 10: สร้างภาพด้วย klein (`tools/images.mjs`)

**Files:**
- Create: `tools/images.mjs`, `tests/images.test.mjs`

**Interfaces:**
- Consumes: `cacheKey`, `libLoad`, `libFindByKey`, `libAdd`, `uploadTemp`, `run`, `withRetry`, `extractMedia`, `download`, `logCost`, `estimate`, `MODELS.image`
- Produces: `generateImage({projectDir, prompt, refs = [], aspect = '9:16', resolution = '1k', seed, need, kind, characters = [], place = null, tags = [], meta, status = 'candidate'}): Promise<{file: string, entry: Entry, cached: boolean, usd: number}>`
  - refs > 4 → `VfError('INTERNAL')`
  - cache hit (`libFindByKey`) → คืนทันที `cached:true, usd:0` + `logCost({..., usd:0, cached:true})`
  - ไม่ hit: `uploadTemp` ทุก ref → `run(MODELS.image, {prompt, images, aspect_ratio: aspect, resolution, seed})` (ไม่ใส่ `images` เมื่อว่าง; seed ไม่กำหนด → สุ่ม `0..2^32-1` แล้วบันทึกใน entry) ห่อ `withRetry` → ดาวน์โหลด → `libAdd` → `logCost` ด้วย `estimate`
  - prompt ที่ส่งจริงต่อท้าย `" No text, no letters, no logos, no watermark."` เสมอ

- [ ] **Step 1: test** (fetch + r2 จำลอง):
  - `เรียกซ้ำด้วยค่าเดิมไม่ยิงโมเดลรอบสอง และ cached true`
  - `ส่ง refs เป็น https URL จาก uploadTemp`
  - `prompt ต่อท้ายด้วย No text`
  - `refs 5 ภาพถูกปฏิเสธ`
- [ ] **Step 2–4:** FAIL → เขียน → PASS
- [ ] **Step 5: Commit** `feat: klein image generation with cache and references`

### Task 11: `vf setup` / `vf doctor` และ spike กับบัญชีจริง

ก่อนเริ่มงานนี้ **Coke ต้องทำเอง** (ผู้ทำแผนต้องหยุดถามถ้ายังไม่พร้อม):
1. เติมเครดิต AI Gateway Unified Billing ใน dashboard
2. เปิดใช้ R2 และสร้าง token สิทธิ์ R2 (Object Read & Write + Admin สำหรับสร้าง bucket) · ให้ token Workers AI มี Read + Edit
3. ใส่ค่าลง `.env` ของ repo ด้วยตัวเอง (ไม่พิมพ์ในแชต) — ทำสคริปต์ `tools/set-env.sh` แบบ `hermes-vps/scripts/set-cloudflare-ai-env.sh` (อ่านแบบซ่อน, เขียน `.env` chmod 600, พิมพ์แค่ความยาว)

**Files:**
- Create: `tools/set-env.sh`, `tools/setup.mjs`, `tools/doctor.mjs`, `tests/doctor.test.mjs`, `spikes/*.mjs`, `spikes/RESULTS.md`

**Interfaces:**
- Produces: `vf doctor [--online]` → `{checks: {name, ok, detail}[]}` · `vf setup` → เหมือน doctor + `ensureBucket` + `putLifecycle` + ทดสอบ R2 (อัปโหลดไฟล์เล็ก แล้ว GET ผ่าน presigned URL) + เรียก LLM ตัวแรกด้วย prompt สั้น `maxTokens 16` (พิสูจน์ว่ามีเครดิต) · checks: `node>=22`, `ffmpeg`, `ffprobe`, `env:<NAME>` (detail = `"ตั้งแล้ว ยาว N"` หรือ `"ยังไม่ตั้ง"`), `cf:token`, `cf:credits`, `r2:bucket`, `r2:presign`
- ผล check ล้มข้อไหน → `ok` ของคำสั่งยังเป็น true แต่ `checks[i].ok=false`; ถ้า env หลักขาด → exit 3

- [ ] **Step 1: test** `doctor ไม่พิมพ์ค่าคีย์` — ตั้ง env ปลอม, รัน `vf doctor` (ไม่ online) → stdout ไม่มีค่าเหล่านั้น และมี `"ยาว"`
- [ ] **Step 2–4:** FAIL → เขียน → PASS · Commit `feat: vf setup and doctor`
- [ ] **Step 5: รัน `vf setup` กับบัญชีจริง** → ทุก check ok (ถ้า `r2:presign` ล้มเพราะการแปลง token → ให้ Coke ตั้ง `VF_R2_ACCESS_KEY_ID/SECRET` แล้วบันทึกใน RESULTS)
- [ ] **Step 6: spike (สคริปต์ทิ้งได้ใน `spikes/`, เรียก `tools/cf.mjs` ตรงๆ, ผลลง `spikes/out/` ที่ git-ignore)** แต่ละข้อบันทึกผลจริงใน `spikes/RESULTS.md` (คำสั่ง, ผล, ค่าที่วัดได้, ข้อสรุปที่จะใช้ในแผน 2–4):
  - **a** klein: prompt ล้วน 9:16 `1k` → ขนาดภาพจริง, เวลา · ส่ง ref 1–4 ภาพผ่าน R2 URL ได้
  - **b** การแปลง `VF_R2_TOKEN` เป็น S3 key ใช้ได้ไหม
  - **c** flux-3-video `i2v` keyframe เดียว 5 วิ `draft:true`: (1) ผ่าน R2 URL (2) base64 ดิบไม่มี prefix → อันไหนใช้ได้, เวลา, ได้ request id หรือรอผลตรง, `generate_audio` ได้เสียงไหม
  - **d** หน่วยราคา flux-3-video — เทียบกับ AI Gateway log/dashboard หลัง spike c (คลิป draft 5 วิ 1 คลิป และ hd 5 วิกับ 10 วิ อย่างละ 1 คลิป)
  - **e** `bria/remove-background`: รูป request/response จริง
  - **f** clef-omni: ชุดเล็ก — ภาพตัวละครเดียวกัน 5 คู่ / ต่างกัน 5 คู่ (สร้างด้วย klein + ref), วัด `same_character`; ภาพมีตัวอักษร 3 / ไม่มี 3 วัด `has_text` → เสนอค่าเกณฑ์ใหม่สำหรับ `qa-rules.mjs` (ค่า >= ที่แยกสองกลุ่มได้)
  - **g** ตัดเฟรมสุดท้ายของคลิปจาก c (`ffmpeg -sseof -0.05 -i v.mp4 -frames:v 1`) → ใช้เป็น keyframe ของคลิปที่สอง → ดูว่าต่อกันเนียนไหม (ภาพ contact sheet)
- [ ] **Step 7:** ปรับ `PRICES` และค่าเกณฑ์ใน `qa-rules.mjs` ตามผล a/d/f พร้อม test ที่เกี่ยวข้อง · Commit `chore: spike results and calibrated prices/thresholds`

### Task 12: `vf project create`

**Files:**
- Create: `tools/paths.mjs`, `tools/md.mjs`, `tools/risk.mjs`, `tools/bible.mjs`, `tools/project-create.mjs`, `tests/bible.test.mjs`, `tests/project-create.test.mjs`, `tests/md.test.mjs`

**Interfaces:**
- Consumes: `llmJson`, `generateImage`, `pickBest`, `RULES`, `openState`, `step`, `startJob`, `logCost`, `writeJsonAtomic`, `libUpdate`
- Produces:
  - `projectsRoot(): string` · `resolveProject(nameOrPath): string` (ไม่มี → USAGE) · `slugify(text): string` — ASCII `a-z0-9-` ยาว ≤40; ผลว่าง → `'project-' + stamp()` · `stamp(d = new Date()): 'YYYYMMDD-HHMM'`
  - `replaceAuto(text, name, content): string` — แทนเนื้อหาระหว่าง `<!-- vf:auto:<name> -->` และ `<!-- /vf:auto:<name> -->`; ไม่มี marker → ต่อท้ายพร้อม marker
  - `riskFindings(text): {id, matched}[]` — port กฎจาก `genhaha/app/lib/promptRisk.ts` (รวม ip, realPerson; ภาษาไทย+อังกฤษ)
  - `BIBLE_SCHEMA` (JSON schema): `{title, logline, premise, world, style_prompt, palette: string[3..6 hex], visual_rules: string[], narrator: boolean, narrator_voice: string, tone, music_style, lang, characters: [{id, name, role, look, personality, voice_description, tts_voice}] (1..6), places: [{id, name, desc}] (1..4), story_rules: string[]}`
  - `validateBible(b): string[]` — id ตรง `/^[a-z][a-z0-9-]{1,30}$/` ไม่ซ้ำ (ตัวละครและสถานที่) · `look.length ≥ 120` · palette เป็น `#RRGGBB` 3–6 ตัว · `tts_voice` อยู่ในรายชื่อ 30 เสียงของ Gemini TTS (คัดจาก `genhaha/app/lib/cinematic/board.ts:36-43`) · `riskFindings` ของ title/look/style/premise ต้องว่าง (issue ระบุคำที่เจอ)
  - `bibleSystemPrompt(lang): string` — สั่ง: ภาพใหญ่ของเรื่องเท่านั้น ไม่ใช่วิดีโอ, look ต้องบอกสี ลาย สัดส่วน จุดเด่นที่ต้องคงที่, ห้ามชื่อคนจริง/แบรนด์/ตัวละครลิขสิทธิ์ (แทนด้วยตัวละครต้นฉบับ), style ไม่ใช้โทนน้ำเงิน-ม่วงเว้นแต่ prompt ขอ, เลือก narrator ตามแนวเรื่อง, ข้อความในฟิลด์เป็นภาษา `lang` ยกเว้น `look`/`style_prompt` เป็นอังกฤษเสมอ
  - `writeProjectFiles(projectDir, bible, {selected: Record<charId, string>, plates: Record<placeId, string>}): void` — เขียน `project.json`, `PROJECT.md` (หัวข้อตาม spec §5; ตาราง/แผนที่ไฟล์/ต้นทุนในบล็อก auto), `characters/<id>/{CHARACTER.md, character.json}`, `places/<id>/{PLACE.md, place.json}`, `EPISODES.md` (หัวตาราง)
  - `vf project create --prompt "..." [--name slug] [--lang en] [--aspect 9:16] [--image <charname>=<path>]... [--foreground]` → (job) ผลเมื่อเสร็จ: `{project, dir, characters: [{id, ref, warning?}], places: [...], cost: {usd}, next: ['vf project show <p>', ...]}`
- ลำดับใน worker (ทุกขั้นห่อด้วย `step(state, ...)` โดย state อยู่ที่ `<project>/.vf/create-state.json`):
  1. `bible` → `llmJson` ด้วย `validateBible`
  2. ต่อตัวละคร `ref:<id>` → `generateImage` 3 ครั้ง (seed ต่างกัน, prompt = `look + ' ' + style_prompt + ' Character reference: single character, full body, front view, neutral pose, plain light background.'`, aspect `3:4`, kind `character-ref`) → `pickBest(RULES.characterRef)` → copy ไปเป็น `characters/<id>/ref/main.png` → `libUpdate` ตัวที่เลือกเป็น `selected`
  3. ต่อสถานที่ `plate:<id>` → `generateWithQa` (`RULES.placePlate`) aspect ของ project, kind `place-plate` → `places/<id>/plates/main.jpg`
  4. `files` → `writeProjectFiles`
- `--image` ของตัวละคร: ใช้ภาพนั้นแทนขั้น 2 (รายละเอียดใน Task 13; ที่นี่แค่ส่งต่อให้ฟังก์ชันเดียวกัน)
- project ที่มีอยู่แล้ว: ถ้า `.vf/create-state.json` ยังไม่ครบ → ทำต่อ; ครบแล้ว → USAGE "มี project นี้แล้ว"
- `--dry-run` (spec §4.1): ไม่เรียกเครือข่ายเลย คืน `{dry_run: true, planned: [{step, model, count}], estimated_usd}` โดยสมมติตัวละคร 3 ตัว สถานที่ 2 แห่ง (บอกสมมติฐานใน `assumptions`) — ใช้ `estimate` ชุดเดียวกับของจริง · `character add`/`place add` (Task 13) รองรับ `--dry-run` แบบเดียวกัน

- [ ] **Step 1: test** `tests/bible.test.mjs`:
  - `validateBible ไม่ผ่าน id ซ้ำ` · `ไม่ผ่าน look สั้น` · `ไม่ผ่าน palette ผิดรูป`
  - **(Review Focus 3)** `validateBible ไม่ผ่านเมื่อ look มีคำว่า Garfield และ issue บอกคำนั้น`
  - **(Review Focus 4)** `slugify('หมาแมวซน') ไม่ว่างและเป็น ASCII` · `slugify('Cat & Dog!') === 'cat-dog'`
  - `replaceAuto แทนเฉพาะบล็อก auto ไม่แตะข้อความอื่น` (`tests/md.test.mjs`)
- [ ] **Step 2:** `tests/project-create.test.mjs` (จำลอง `llmJson`/`generateImage`/`clef` ด้วย fetch จำลองทั้งหมด, `--foreground`):
  - `สร้างไฟล์ครบตาม spec §5` — มี `PROJECT.md`, `project.json`, `characters/cat/ref/main.png`, `characters/cat/CHARACTER.md`, `places/<id>/plates/main.jpg`, `EPISODES.md`, `library/index.json` (3 entry ต่อตัวละคร, 1 เป็น `selected`)
  - **(Review Focus 2)** `รันซ้ำหลังพังที่ตัวละครที่สองไม่สร้างตัวแรกใหม่` — fetch จำลองโยน error ตอนภาพแรกของตัวที่สอง → รันใหม่ → จำนวน request สร้างภาพของตัวแรกเท่าเดิม
  - `ไม่มี --foreground คืน job ทันที` (มี `job.id`)
  - `--dry-run ไม่ยิง fetch เลยและคืน estimated_usd > 0`
- [ ] **Step 3–5:** FAIL → เขียน → PASS
- [ ] **Step 6: Commit** `feat: vf project create`

### Task 13: `vf character add`, `vf place add`, ตัวละครจากภาพ

**Files:**
- Create: `tools/character-add.mjs`, `tools/place-add.mjs`, `tests/character-add.test.mjs`
- Modify: `tools/bible.mjs` (เพิ่ม `CHARACTER_SCHEMA`, `PLACE_SCHEMA`, `lookFromImageSystemPrompt`, `addCharacterFiles`, `addPlaceFiles`)

**Interfaces:**
- Consumes: ทุกอย่างจาก Task 12
- Produces:
  - `vf character add <project> --prompt "..." [--image <path>]... [--id <id>] [--replace] [--foreground]` → `{character: {id, ref, look, warning?}}`
    - ไม่มี `--image`: `llmJson` ด้วย PROJECT.md เป็นบริบท (system: ให้เข้ากับโลกและสไตล์เดิม, id ต้องไม่ซ้ำกับตัวที่มี) → สร้าง 3 แบบเหมือน Task 12 ขั้น 2 แต่ส่ง `ref/main.png` ของตัวละครเดิมได้สูงสุด 2 ภาพเป็น style reference
    - มี `--image`: copy ภาพแรกเป็น `ref/main.png` (ภาพอื่นเป็น `ref/extra-N.png`) → `llmJson` พร้อม `images` (data URI) ให้เขียน `look` จากภาพ → QA เหลือ `single_character ≥ 0.7 && has_text < 0.3` (ไม่ผ่าน = warning ไม่ใช่ error)
    - id มีอยู่แล้วและไม่มี `--replace` → USAGE · `--replace` → ย้ายของเดิมไป `characters/<id>/ref/old-<stamp>/`
    - อัปเดต `PROJECT.md` บล็อก auto `characters` และ `files`
  - `vf place add <project> --prompt "..." [--id] [--foreground]` → `{place: {id, plate}}`
- [ ] **Step 1: test:** `character add เพิ่มแถวในตาราง PROJECT.md โดยไม่แตะข้อความที่เขียนเอง` · `id ซ้ำไม่มี --replace ได้ USAGE` · `--image ไม่เรียกโมเดลสร้างภาพเลย` · `--replace เก็บภาพเก่าไว้`
- [ ] **Step 2–4:** FAIL → เขียน → PASS
- [ ] **Step 5: Commit** `feat: add characters and places, characters from existing images`

### Task 14: `vf project show`, `vf asset find`

**Files:**
- Create: `tools/project-show.mjs`, `tools/asset-find.mjs`, `tests/show-find.test.mjs`

**Interfaces:**
- Produces:
  - `vf project show <project>` → `{project, dir, title, logline, lang, aspect, narrator, characters: [{id, name, role, ref, poses: string[]}], places: [{id, name, plates: string[]}], episodes: number, last_episodes: [...≤5], cost_total_usd, files: {project_md, episodes_md}}`
  - `vf asset find <project> <terms...> [--kind ...] [--character id] [--limit 10]` → `{results: [{id, kind, file, score, tags, status, need}]}`
- [ ] **Step 1: test:** `show อ่าน project จาก fixture ได้ครบ` · `asset find แมว กระโดด คืน path ที่มีอยู่จริง`
- [ ] **Step 2–4:** FAIL → เขียน → PASS
- [ ] **Step 5: Commit** `feat: project show and asset find`

### Task 15: skill ส่วนแรก + smoke test จริง

**Files:**
- Create: `skills/videofactoro/SKILL.md`, `skills/videofactoro/references/project.md`, `.claude/skills/videofactoro` (symlink → `../../skills/videofactoro`), `docs/README.md`

- [ ] **Step 1:** `SKILL.md` (frontmatter `name: videofactoro`, `description` บอกให้ใช้เมื่อผู้ใช้ขอทำวิดีโอ/คลิป/ตัวละคร/เรื่อง): กฎเหล็กตาม spec §13 (สร้าง project ก่อนเสมอ; อ่าน `vf project show` + PROJECT.md ก่อนทุกงาน; ห้ามถามผู้ใช้กลางทาง; ห้ามชื่อลิขสิทธิ์; exit 3 = หยุดแล้วรายงาน, exit 5 = รันคำสั่งเดิมซ้ำ, exit 4 = เขียน prompt ใหม่แบบทั่วไป; คำสั่งยาวคืน job → เรียก `vf wait` วนจน done/failed; ห้ามอ่านหรือพิมพ์ `.env`) · ลำดับ: `vf doctor` → `vf project create` → `vf wait` → รายงานผู้ใช้ (ตัวละคร, path ภาพ, ต้นทุน) · ส่วนโหมดวิดีโอเขียนว่า "ยังไม่มี (แผน 2–4)"
- [ ] **Step 2:** `references/project.md`: โครงไฟล์ project (spec §5) และกฎแก้ PROJECT.md (แก้ได้นอกบล็อก auto เท่านั้น)
- [ ] **Step 3:** ทดสอบทั้งชุด `npm test` → PASS ทั้งหมด
- [ ] **Step 4: smoke จริง:** `vf project create --prompt "A chubby ginger cat and a shy beagle puppy share a small apartment and get into silly trouble" --name smoke-catdog` → `vf wait smoke-catdog` จน done → ตรวจด้วยตา: ภาพ `ref/main.png` ทั้งสองตัวเป็นตัวเดียว ไม่มีตัวอักษร · PROJECT.md อ่านรู้เรื่อง · `vf project show` ถูก · ต้นทุนรวมใน PROJECT.md สมเหตุสมผล (คาดราว $0.06–0.15)
- [ ] **Step 5:** `vf character add smoke-catdog --prompt "a tiny grey mouse neighbour"` → ภาพสไตล์เข้ากับสองตัวแรก
- [ ] **Step 6:** เปิด Claude Code ใหม่ใน repo แล้วพิมพ์ "สร้าง project เรื่องเพนกวินทำร้านกาแฟ" → ตรวจว่า agent ใช้ skill ถูกลำดับโดยไม่ถามคำถาม (บันทึกผลใน `spikes/RESULTS.md` หัวข้อ smoke)
- [ ] **Step 7: Commit** `feat: agent skill (project part) and smoke results`
