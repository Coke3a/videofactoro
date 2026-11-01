import { getFetch, sleep, scrub } from "./cf.mjs";

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
async function gatewayLogs({ account, token, gateway, run, start, end }) {
  const filters = encodeURIComponent(JSON.stringify([{ key: "metadata.value", operator: "eq", value: [run] }]));
  const rows = [];
  for (let page = 1; ; page++) {
    const url = `${API}/accounts/${account}/ai-gateway/gateways/${gateway}/logs?filters=${filters}` +
      `&start_date=${encodeURIComponent(start)}&end_date=${encodeURIComponent(end)}&per_page=${PER_PAGE}&page=${page}`;
    const j = await getJson(url, token);
    const got = j.result ?? [];
    rows.push(...got);
    const total = j.result_info?.total_count ?? 0;
    if (!got.length || page * PER_PAGE >= total) break;
  }
  // metadata.value eq จับทุกช่องที่มีค่าเท่ากับ run จึงกรองซ้ำที่ฝั่งเรา
  return rows.filter((r) => runOf(r.metadata) === run);
}

function sumGateway(rows) {
  const by_model = {};
  let usd = 0;
  for (const r of rows) {
    const c = typeof r.cost === "number" ? r.cost : 0;
    const m = (by_model[r.model] ??= { calls: 0, usd: 0 });
    m.calls++;
    m.usd += c;
    usd += c;
  }
  return { usd, gateway: { calls: rows.length, by_model } };
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

export async function fetchActualCost({ run, start, end, expectedGatewayCalls = 0 }) {
  const base = { run, start, end };
  const account = process.env.CLOUDFLARE_AI_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_AI_API_TOKEN;
  const gateway = process.env.VF_AIG_GATEWAY_ID ?? "default";
  const done = (rest) => ({ ...base, ...rest, fetched_at: new Date().toISOString() });
  if (!account || !token) return done({ status: "unavailable", usd: null, gateway: null, neurons: null, error: "ไม่มี CLOUDFLARE_AI_ACCOUNT_ID/CLOUDFLARE_AI_API_TOKEN" });

  let sum;
  try {
    // log เข้า Gateway ช้ากว่าการเรียกไม่กี่วินาที: รอจนครบจำนวนที่ ledger บอก หรือครบ MAX_LOG_FETCHES ครั้ง
    for (let i = 1; ; i++) {
      sum = sumGateway(await gatewayLogs({ account, token, gateway, run, start, end }));
      if (sum.gateway.calls >= expectedGatewayCalls || i >= MAX_LOG_FETCHES) break;
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
  const status = sum.gateway.calls < expectedGatewayCalls || neurons === null ? "partial" : "ok";
  return done({ status, usd: round6(sum.usd), gateway: sum.gateway, neurons, ...(error ? { error } : {}) });
}
