// โหลดก่อนทุกไฟล์ทดสอบ (package.json --import): ห้าม test ไปเรียก API ค่าใช้จ่ายจริงของ Cloudflare
import { setActualCostFetcher } from "../tools/entities.mjs";

export const STUB_COST = { usd: 0.123, status: "ok", neurons: 7 };
setActualCostFetcher(async (q) => ({ ...q, status: "ok", usd: 0.123, gateway: null, neurons: { total: 7, by_model: {} }, fetched_at: "t" }));
