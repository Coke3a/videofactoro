# videofactoro

CLI `vf` (Node 22, ไม่มี dependency) ให้ LLM agent สั่งทำวิดีโอ AI ผ่าน Cloudflare Workers AI เท่านั้น

## ติดตั้ง

รันใน Terminal ของคุณเอง (ไม่ต้องพิมพ์คีย์ลงไฟล์หรือในแชต):

```sh
bash tools/set-env.sh         # ถามค่าแบบซ่อนตัวอักษร แล้วเขียน .env (chmod 600, git-ignored)
node bin/vf.mjs setup         # ทดสอบ token และเตรียม R2 bucket
node tools/install-hooks.mjs  # ติดตั้ง pre-commit กันคีย์หลุด
node bin/vf.mjs doctor        # ตรวจซ้ำได้ทุกเมื่อ (อ่านอย่างเดียว)
```

`.env.example` เป็นแค่รายชื่อตัวแปรที่ใช้ (ไม่ต้องคัดลอก) `set-env.sh` เป็นคนเขียน `.env` ให้

ทดสอบ: `npm test`
