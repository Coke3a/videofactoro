#!/usr/bin/env bash
# รันบนเครื่องของคุณเอง ใน Terminal ของคุณเอง (ต้องมี TTY เพื่อไม่ให้ค่าคีย์โชว์บนจอ)
# เขียนค่าลง <repo>/.env (chmod 600) พิมพ์แค่ชื่อกับความยาว ไม่เรียกเครือข่ายเลย
# หลังเสร็จให้รัน: node bin/vf.mjs setup
#   ENV_FILE=...   ไฟล์ปลายทาง (ใช้ตอนทดสอบ) ค่าเริ่มต้น <repo>/.env
set -euo pipefail
umask 077

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$REPO/.env}"
mkdir -p "$(dirname "$ENV_FILE")"

strip() { tr -d '[:space:]'; }
ask()   { local v; read -r -p "$1: " v; printf '%s' "$v" | strip; }
asks()  { local v; read -rs -p "$1 (พิมพ์แล้วไม่แสดงบนจอ): " v; echo >&2; printf '%s' "$v" | strip; }
fail()  { echo "ผิดรูปแบบ: $1 - ยังไม่ได้เขียนอะไรลงไฟล์" >&2; exit 1; }
# Current value of NAME in ENV_FILE (last match), used so Enter keeps it. Never printed.
cur()   { [ -f "$ENV_FILE" ] || return 0; grep -E "^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- | strip; }
keep()  { local hint=""; [ -n "$(cur "$1")" ] && hint=" (กด Enter = ใช้ค่าเดิม)"; local v; v=$(asks "$1$2$hint"); printf '%s' "${v:-$(cur "$1")}"; }

echo "Account ID: dash.cloudflare.com > Workers & Pages > ขวามือ" >&2
echo "CLOUDFLARE_AI_API_TOKEN: สิทธิ์ Workers AI Read + Edit | VF_R2_TOKEN: สิทธิ์ R2 (Object Read & Write + Admin ถ้าให้ vf สร้าง bucket)" >&2
ACCT=$(keep CLOUDFLARE_AI_ACCOUNT_ID " (32 ตัว hex)")
TOK=$(keep CLOUDFLARE_AI_API_TOKEN "")
BUCKET=$(ask "VF_R2_BUCKET (กด Enter = videofactoro)")
BUCKET="${BUCKET:-videofactoro}"
echo "R2 ใช้แค่ตอนทำวิดีโอ: ยังไม่ทำวิดีโอ กด Enter ข้ามได้ทั้งหมด (ค่า R2 เดิมในไฟล์จะคงไว้)" >&2
R2TOK=$(asks "VF_R2_TOKEN (เว้นว่างได้ถ้าจะใส่ access key ด้านล่าง)")
echo "ทางเลือก: ถ้า VF_R2_TOKEN แปลงเป็น S3 key ไม่ได้ ใส่ R2 access key ได้ที่นี่ (เว้นว่าง = ข้าม)" >&2
AKID=$(asks "VF_R2_ACCESS_KEY_ID")
SAK=$(asks  "VF_R2_SECRET_ACCESS_KEY")

[[ "$ACCT"   =~ ^[0-9a-f]{32}$ ]]                    || fail CLOUDFLARE_AI_ACCOUNT_ID
[[ "$TOK"    =~ ^[A-Za-z0-9_-]{30,200}$ ]]          || fail CLOUDFLARE_AI_API_TOKEN
[[ "$BUCKET" =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]] || fail VF_R2_BUCKET
[ -z "$R2TOK" ] || [[ "$R2TOK" =~ ^[A-Za-z0-9_-]{30,200}$ ]] || fail VF_R2_TOKEN
[ -z "$AKID" ]  || [[ "$AKID"  =~ ^[A-Za-z0-9]{16,64}$ ]]    || fail VF_R2_ACCESS_KEY_ID
[ -z "$SAK" ]   || [[ "$SAK"   =~ ^[A-Za-z0-9/+=_-]{32,200}$ ]] || fail VF_R2_SECRET_ACCESS_KEY
{ [ -n "$AKID" ] && [ -n "$SAK" ]; } || { [ -z "$AKID" ] && [ -z "$SAK" ]; } || fail "ต้องใส่ access key id และ secret ให้ครบคู่"

NAMES="CLOUDFLARE_AI_ACCOUNT_ID CLOUDFLARE_AI_API_TOKEN"
ALL="$NAMES"
HAS_R2=""
{ [ -z "$R2TOK" ] && [ -z "$AKID" ]; } || HAS_R2=1
if [ -n "$HAS_R2" ]; then
  NAMES="$NAMES VF_R2_BUCKET"
  [ -z "$R2TOK" ] || NAMES="$NAMES VF_R2_TOKEN"
  [ -z "$AKID" ]  || NAMES="$NAMES VF_R2_ACCESS_KEY_ID VF_R2_SECRET_ACCESS_KEY"
  ALL="$NAMES VF_R2_TOKEN VF_R2_ACCESS_KEY_ID VF_R2_SECRET_ACCESS_KEY"
fi
PATTERN="^[[:space:]]*(export[[:space:]]+)?($(echo "$ALL" | tr ' ' '|'))[[:space:]]*="

tmp=$(mktemp "$(dirname "$ENV_FILE")/.env.XXXXXX")
trap 'rm -f "$tmp"' EXIT
{
  if [ -f "$ENV_FILE" ]; then grep -Ev "$PATTERN" "$ENV_FILE" || true; fi
  printf 'CLOUDFLARE_AI_ACCOUNT_ID=%s\n' "$ACCT"
  printf 'CLOUDFLARE_AI_API_TOKEN=%s\n'  "$TOK"
  [ -z "$HAS_R2" ] || printf 'VF_R2_BUCKET=%s\n' "$BUCKET"
  [ -z "$R2TOK" ] || printf 'VF_R2_TOKEN=%s\n' "$R2TOK"
  if [ -n "$AKID" ]; then
    printf 'VF_R2_ACCESS_KEY_ID=%s\n'     "$AKID"
    printf 'VF_R2_SECRET_ACCESS_KEY=%s\n' "$SAK"
  fi
} > "$tmp"
chmod 600 "$tmp"
mv -f "$tmp" "$ENV_FILE"
trap - EXIT

MODE=$(stat -c %a "$ENV_FILE" 2>/dev/null || stat -f %Lp "$ENV_FILE")
echo "เขียนแล้ว ($MODE $ENV_FILE):"
for n in $NAMES; do
  printf '  %-26s ยาว %s ตัวอักษร\n' "$n" "$(grep -E "^$n=" "$ENV_FILE" | cut -d= -f2- | tr -d '\n' | wc -c | tr -d ' ')"
done
echo "ขั้นต่อไป: node bin/vf.mjs setup"
