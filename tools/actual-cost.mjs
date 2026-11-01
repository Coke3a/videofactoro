import { getFetch, sleep, scrub, isCfHosted } from "./cf.mjs";

// ค่าใช้จ่ายจริงของการรันหนึ่งรอบ (หนึ่ง attempt) ตามที่ Cloudflare รายงาน — ห้ามคำนวณจากตารางราคาเอง
// AI Gateway logs ให้ USD ของโมเดลภายนอก · Workers AI (@cf/*) ไม่อยู่ใน logs จึงรายงานเป็น Neurons เท่านั้น
const API = "https://api.cloudflare.com/client/v4";
const POLL_MS = 15000;
const MAX_LOG_FETCHES = 6;
const PER_PAGE = 50;

const NEURONS_QUERY = `query($a:String!,$s:Time!,$e:Time!){viewer{accounts(filter:{accountTag:$a}){
  aiInferenceAdaptiveGroups(limit:100, filter:{datetime_geq:$s, datetime_leq:$e}){dimensions{modelId} sum{totalNeurons} count}}}}`;

async function getJson(url, token, body) {
  const res = await getFetch()(url, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Cloudflare ตอบ ${res.status}: ${scrub(text)}`);
  return JSON.parse(text);
}

const runOf = (m) => {
  if (typeof m !== "string") return m?.run;
  try { return JSON.parse(m)?.run; } catch { return undefined; }
};

// filter แบบ JSON เท่านั้น: แบบ filters[0][key] API เงียบไม่กรองให้ (ทดสอบ 2026-11-01)
// ไม่จำกัดช่วงเวลา: ดึงทุก attempt ของ run (รวม attempt ที่ process ตายกลางทาง) แล้วตัดที่บันทึกไปแล้วด้วย log id
async function gatewayLogs({ account, token, gateway, run }) {
  const filters = encodeURIComponent(JSON.stringify([{ key: "metadata.value", operator: "eq", value: [run] }]));
  const rows = [];
  for (let page = 1; ; page++) {
    const url = `${API}/accounts/${account}/ai-gateway/gateways/${gateway}/logs?filters=${filters}&per_page=${PER_PAGE}&page=${page}`;
    const j = await getJson(url, token);
    const got = j.result ?? [];
    rows.push(...got);
    const total = j.result_info?.total_count ?? 0;
    if (!got.length || page * PER_PAGE >= total) break;
  }
  // metadata.value eq จับทุกช่องที่มีค่าเท่ากับ run จึงกรองซ้ำที่ฝั่งเรา
  const seen = new Set();
  return rows.filter((r) => runOf(r.metadata) === run && !(r.id && seen.has(r.id)) && (seen.add(r.id), true));
}

// แถวที่เป็นการเรียกโมเดลที่เสียเงินผ่าน Gateway จริง: ไม่ใช่ @cf (คิดเป็น Neurons) และไม่ใช่ poll /ai/requests (provider unknown, cost 0)
const isPaidRow = (r) => typeof r.model === "string" && !isCfHosted(r.model) && r.provider !== "unknown";

function sumGateway(rows) {
  const by_model = {};
  const unpriced = new Set();
  let usd = 0;
  for (const r of rows) {
    // Gateway ไม่มีราคาให้ = ไม่รู้ ห้ามนับเป็น $0 แบบยืนยัน
    if (typeof r.cost !== "number") unpriced.add(r.model);
    const c = typeof r.cost === "number" ? r.cost : 0;
    const m = (by_model[r.model] ??= { calls: 0, usd: 0 });
    m.calls++;
    m.usd += c;
    usd += c;
  }
  return { usd, gateway: { calls: rows.length, by_model }, unpriced: [...unpriced], ids: rows.map((r) => r.id).filter(Boolean) };
}

async function workersNeurons({ account, token, start, end }) {
  const j = await getJson(`${API}/graphql`, token, { query: NEURONS_QUERY, variables: { a: account, s: start, e: end } });
  if (j.errors?.length) throw new Error(`GraphQL: ${scrub(j.errors.map((e) => e.message).join("; "))}`);
  const by_model = {};
  let total = 0;
  for (const g of j.data?.viewer?.accounts?.[0]?.aiInferenceAdaptiveGroups ?? []) {
    const n = g.sum?.totalNeurons ?? 0;
    by_model[g.dimensions.modelId] = (by_model[g.dimensions.modelId] ?? 0) + n;
    total += n;
  }
  return { total, by_model };
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

// expectedGatewayCalls = จำนวนเรียกที่เสียเงินของทั้ง run (ทุก attempt) · seenIds = log id ที่ attempt ก่อนหน้าบันทึกไปแล้ว
export async function fetchActualCost({ run, start, end, expectedGatewayCalls = 0, seenIds = [] }) {
  const base = { run, start, end };
  const account = process.env.CLOUDFLARE_AI_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_AI_API_TOKEN;
  const gateway = process.env.VF_AIG_GATEWAY_ID ?? "default";
  const done = (rest) => ({ ...base, ...rest, fetched_at: new Date().toISOString() });
  if (!account || !token) return done({ status: "unavailable", usd: null, gateway: null, neurons: null, error: "ไม่มี CLOUDFLARE_AI_ACCOUNT_ID/CLOUDFLARE_AI_API_TOKEN" });

  const seen = new Set(seenIds);
  let sum;
  let short = false;
  try {
    // log เข้า Gateway ช้ากว่าการเรียกไม่กี่วินาที: รอจนครบจำนวนที่ ledger บอก หรือครบ MAX_LOG_FETCHES ครั้ง
    for (let i = 1; ; i++) {
      const paid = (await gatewayLogs({ account, token, gateway, run })).filter(isPaidRow);
      sum = sumGateway(paid.filter((r) => !seen.has(r.id)));
      if (paid.length >= expectedGatewayCalls || i >= MAX_LOG_FETCHES) {
        short = paid.length < expectedGatewayCalls;
        break;
      }
      await sleep(POLL_MS);
    }
  } catch (e) {
    return done({ status: "unavailable", usd: null, gateway: null, neurons: null, error: scrub(e?.message ?? String(e)) });
  }

  let neurons = null;
  let error;
  try {
    neurons = await workersNeurons({ account, token, start, end });
  } catch (e) {
    error = scrub(e?.message ?? String(e));
  }
  for (const m of Object.values(sum.gateway.by_model)) m.usd = round6(m.usd);
  const status = short || neurons === null || sum.unpriced.length ? "partial" : "ok";
  return done({
    status, usd: round6(sum.usd), gateway: sum.gateway, log_ids: sum.ids,
    // Neurons มาจาก GraphQL ทั้ง account ในช่วงเวลานี้ ไม่ได้แยกตาม run
    neurons, neurons_scope: "account-window",
    ...(sum.unpriced.length ? { unpriced_models: sum.unpriced } : {}), ...(error ? { error } : {}),
  });
}
