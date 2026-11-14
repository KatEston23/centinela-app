// Robo-Advisor de Revolut: Revolut no tiene API, así que se sigue con su extracto de cuenta
// (mismo formato que el de Invest) y los precios públicos de sus fondos (Yahoo).
// Solo observa: nunca opera.
import { analyze, mapLimit } from "./lib.mjs";

// Tickers de Revolut → símbolo de Yahoo (resuelto por precio el 14-nov-2026). Los nuevos se resuelven solos.
export const ROBO_MAP = {
  LYTR: "LYTR.DE", LYP6: "LYP6.DE", EMBH: "EMBHI.MI", XDWI: "XDWI.DE", LKOR: "LKOR.DE", QDV7: "QDV7.MU",
  UBUD: "UBUD.DE", LYMS: "LYMS.DE", AEHY: "AEHY.DE", TRDE: "TRDE.DE", PRAR: "PRAR.DE", PRAJ: "PRAJ.DE",
  "79U0": "79U0.DU", PRAC: "PRAC.DE", LEMA: "LEMA.DE", CEMM: "CEMM.DE", WELK: "WELK.DE", LYP5: "LYP5.DE", EMXC: "EMXC.DE",
};
const BENCH = "EUNL.DE"; // iShares Core MSCI World (EUR): el indexado con el que se compara
const SUFFIX = [".DE", ".F", ".MU", ".DU", ".PA", ".AS", ".MI", ".SW", ".BE", ".SG"];
const UA = { headers: { "User-Agent": "Mozilla/5.0" } };
const DAY = 864e5;

/** Busca el símbolo de Yahoo cuyo precio en EUR se parece más al de compra (±5 %). */
async function resolve(ticker, refPrice) {
  let best = null;
  for (const s of SUFFIX) {
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker + s)}?range=5d&interval=1d`, UA);
      if (!r.ok) continue;
      const m = (await r.json())?.chart?.result?.[0]?.meta;
      if (!m?.regularMarketPrice || m.currency !== "EUR") continue;
      const dev = refPrice ? Math.abs(m.regularMarketPrice / refPrice - 1) : 0;
      if (!best || dev < best.dev) best = { sym: ticker + s, dev };
      if (dev < 0.03) break;
    } catch { /* se prueba el siguiente mercado */ }
  }
  return best && best.dev < 0.05 ? best.sym : null;
}

// Clase de activo y región a partir del nombre del fondo
export function classify(name = "") {
  const n = name.replace(/S Plus P/g, "S&P");
  const cls = /Commodit/i.test(n) ? "Materias primas"
    : /Bond|Treasury|Gilt|Government|Govt|Corporate|High Yield|Aggregate|TIPS|Obligation/i.test(n) ? "Bonos" : "Acciones";
  const region = /Emerging/i.test(n) ? "Emergentes" : /Korea/i.test(n) ? "Corea" : /Japan/i.test(n) ? "Japón"
    : /UK |Gilt/i.test(n) ? "Reino Unido" : /S&P 500|Nasdaq|\bUS\b|USA|Treasury/i.test(n) ? "EE. UU."
    : /Europe|Stoxx|\bEUR\b|\bEuro\b/i.test(n) ? "Europa" : "Mundo";
  return { cls, region };
}
export const shortName = (n = "") => n
  .replace(/^(Amundi Index Solutions|iShares III Public Limited Company|Amundi ETF ICAV|MUL)\s*-?\s*/i, "")
  .replace(/S Plus P/g, "S&P").replace(/\s*\(C\)/g, "")
  .replace(/\b(UCITS|ETF|Acc|Accumulation|Dist|DR|Capitalisation|1C|USD dis|SU)\b/g, "")
  .replace(/\s+-\s+EUR\s*$/, "").replace(/\s{2,}/g, " ").trim();

/**
 * Calcula todo lo del robot y lo deja en s.robot: posiciones, valor, reparto, movimientos y comparación.
 * holdingsFromLedger: el mismo cálculo de posiciones que usa la cartera de Invest.
 */
export async function updateRobot(s, holdingsFromLedger, now = new Date()) {
  const R = s.robot;
  if (!R?.ledger?.rows?.length) return null;
  const rows = R.ledger.rows;
  R.map = { ...ROBO_MAP, ...(R.map || {}) };
  const H = holdingsFromLedger(rows).filter((h) => h.qty > 1e-9);
  // Tickers nuevos (el robot ha comprado otro fondo): se resuelven por el precio de compra
  for (const h of H) if (!R.map[h.symbol]) { const sym = await resolve(h.symbol, h.avg); if (sym) R.map[h.symbol] = sym; }
  const syms = [...new Set([...H.map((h) => R.map[h.symbol]).filter(Boolean), BENCH])];
  const Q = Object.fromEntries((await mapLimit(syms, 4, (x) => analyze(x))).filter((q) => q && !q.error).map((q) => [q.symbol, q]));

  // Posiciones
  let value = 0, today = 0;
  const pos = H.map((h) => {
    const q = Q[R.map[h.symbol]];
    const price = q?.price ?? h.avg;
    const v = h.qty * price;
    value += v;
    if (q?.change1d != null) today += v - v / (1 + q.change1d);
    const name = q?.name || h.symbol;
    return { t: h.symbol, sym: R.map[h.symbol] || null, name: shortName(name), ...classify(name), qty: h.qty, avg: h.avg, cost: h.qty * (h.avg || 0), price, value: v, ch1d: q?.change1d ?? null, priced: !!q };
  });
  // Efectivo del robot y dinero aportado
  let cash = 0, invested = 0, fees = 0;
  for (const r of rows) {
    const a = Math.abs(Number(r.tot) || 0);
    if (r.k === "cash") { cash += a; invested += a; }
    else if (r.k === "out") { cash -= a; invested -= a; }
    else if (r.k === "buy") cash -= a;
    else if (r.k === "sell" || r.k === "div") cash += a;
    else if (r.k === "fee") { cash -= a; fees += a; }
  }
  cash = Math.max(0, Math.round(cash * 100) / 100);
  const total = value + cash;
  for (const p of pos) p.weight = total ? p.value / total : 0;
  pos.sort((a, b) => b.value - a.value);
  const group = (k) => Object.entries(pos.reduce((m, p) => ((m[p[k]] = (m[p[k]] || 0) + p.value), m), {}))
    .map(([name, v]) => ({ name, w: total ? v / total : 0 })).sort((a, b) => b.w - a.w);

  // Qué ha hecho el robot, por días
  const byDay = new Map();
  for (const r of rows) {
    const d = String(r.d).slice(0, 10);
    const g = byDay.get(d) || { d, topup: 0, out: 0, buys: [], sells: [], fees: 0, divs: 0 };
    const a = Math.abs(Number(r.tot) || 0);
    if (r.k === "cash") g.topup += a; else if (r.k === "out") g.out += a;
    else if (r.k === "buy") g.buys.push({ t: r.t, eur: a }); else if (r.k === "sell") g.sells.push({ t: r.t, eur: a });
    else if (r.k === "fee") g.fees += a; else if (r.k === "div") g.divs += a;
    byDay.set(d, g);
  }
  const first = [...byDay.keys()].sort()[0];
  const moves = [...byDay.values()].sort((a, b) => b.d.localeCompare(a.d)).map((g) => ({
    ...g,
    kind: g.sells.length && g.buys.length ? "Reequilibrio" : g.d === first && g.buys.length ? "Inversión inicial" : g.buys.length ? "Compra" : g.sells.length ? "Venta" : g.topup ? "Aportación" : g.out ? "Retirada" : g.fees ? "Comisión" : g.divs ? "Dividendos" : "Movimiento",
  }));

  // Comparación: el mismo dinero, en las mismas fechas, en un indexado del MSCI World
  let bench = null;
  const B = Q[BENCH];
  if (B?.history?.length) {
    const px = (day) => { let p = null; for (const [d, c] of B.history) { if (d <= day) p = c; else break; } return p ?? B.history[0][1]; };
    let units = 0;
    for (const r of rows) {
      const a = Math.abs(Number(r.tot) || 0), day = Math.floor(new Date(r.d).getTime() / DAY);
      if (r.k === "cash") units += a / px(day); else if (r.k === "out") units -= a / px(day);
    }
    const bv = units * B.price;
    bench = { sym: BENCH, name: shortName(B.name || "iShares Core MSCI World"), value: bv, pnl: bv - invested, pnlPct: invested ? bv / invested - 1 : null };
  }

  // Valor de cada día (uno por día) para la gráfica del robot
  const dkey = now.toISOString().slice(0, 10);
  R.daily = { ...(R.daily || {}), [dkey]: Math.round(total * 100) / 100 };
  const keys = Object.keys(R.daily).sort(); if (keys.length > 800) for (const k of keys.slice(0, keys.length - 800)) delete R.daily[k];

  Object.assign(R, {
    at: now.toISOString(), positions: pos, value: total, invested, cash, fees,
    pnl: total - invested, pnlPct: invested ? total / invested - 1 : null,
    today, todayPct: total - today ? today / (total - today) : null,
    byClass: group("cls"), byRegion: group("region"), moves: moves.slice(0, 60),
    feeYear: total * 0.0075, startedAt: first, bench, priced: pos.filter((p) => p.priced).length,
  });
  return R;
}
