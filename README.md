# videofactoro

CLI `vf` (Node 22, ไม่มี dependency) ให้ LLM agent สั่งทำวิดีโอ AI ผ่าน Cloudflare Workers AI เท่านั้น

## ติดตั้ง

```sh
cp .env.example .env        # แล้วกรอกค่า (ห้าม commit .env)
node tools/install-hooks.mjs  # ติดตั้ง pre-commit กันคีย์หลุด
vf doctor                   # ตรวจว่าตั้งค่าครบ
```

ทดสอบ: `npm test`
