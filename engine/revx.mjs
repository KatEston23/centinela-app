// Revolut X (solo lectura) con la CLI oficial: saldos, coste medio y precio en vivo.
// Lo usan el motor (cloud-run.mjs) y el script local (revx-sync.mjs).
//
// Correcciones frente a la versión anterior:
//  · La cantidad incluye lo que esté en staking (la API lo da aparte de `total`).
//  · El coste cuenta TODAS las compras, no solo las pagadas en EUR: USD, USDC, USDT, GBP o con otra
//    cripto se pasan a euros con el cambio del día de la operación.
//  · Lo recibido (traspasos desde la app de Revolut o desde otra cartera) entra al precio de mercado
//    de ese día (coste estimado) en vez de quedar fuera; las recompensas entran a coste cero.
//  · Ventas, envíos y permutas restan coste en proporción. Si lo calculado no cuadra con el saldo,
//    se marca (qtyGap) y el coste se escala al saldo real.
//  · Precio en vivo del propio Revolut X (mid del libro), para que el valor coincida con la app.
//  · Si la CLI falla se conserva el último saldo, pero se marca como desfasado (stale) con el error.
import { execFileSync, execSync } from "node:child_process";
import { fetchChart } from "./lib.mjs";

export const FIAT = new Set(["EUR", "USD", "GBP"]);
const USD_PEG = new Set(["USD", "USDC", "USDT", "DAI", "PYUSD", "RLUSD"]);
// Criptos que en Yahoo tienen otro símbolo (choque de nombres)
export const YF_ALIAS = { "MON-EUR": "MON30495-USD" };

function revx(args) {
  // En Windows los .cmd necesitan shell; los argumentos son fijos (sin datos externos)
  const opts = { encoding: "utf8", timeout: 90000, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 };
  return process.platform === "win32" ? execSync(["revx", ...args].join(" "), opts) : execFileSync("revx", args, opts);
}
const num = (x) => { const n = Number(x); return isFinite(n) ? n : 0; };
const dayOf = (ms) => Math.floor(ms / 864e5);
const tsMs = (v) => (isNaN(Number(v)) ? new Date(v).getTime() : Number(v));

// Series diarias de Yahoo (5 años) en caché: día → cierre
const seriesCache = new Map();
async function dailySeries(sym) {
  if (seriesCache.has(sym)) return seriesCache.get(sym);
  const p = (async () => {
    try {
      const r = await fetchChart(sym, "5y");
      const ts = r.timestamp || [], c = r.indicators?.quote?.[0]?.close || [];
      const days = [], vals = [];
      for (let i = 0; i < ts.length; i++) if (c[i] != null) { days.push(Math.floor(ts[i] / 86400)); vals.push(c[i]); }
      return { days, vals, currency: r.meta?.currency };
    } catch { return null; }
  })();
  seriesCache.set(sym, p);
  return p;
}
function valueOn(series, day) {
  if (!series?.days.length) return null;
  // Último cierre en o antes de ese día (fines de semana y festivos: el anterior)
  let lo = 0, hi = series.days.length - 1, best = null;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (series.days[m] <= day) { best = m; lo = m + 1; } else hi = m - 1; }
  return best == null ? series.vals[0] : series.vals[best];
}
/** Euros por 1 unidad de `cur` en el día dado (fiat, estables o cripto). */
async function eurPerOn(cur, day) {
  cur = String(cur || "").toUpperCase();
  if (cur === "EUR") return 1;
  if (USD_PEG.has(cur)) { const s = await dailySeries("EURUSD=X"); const v = valueOn(s, day); return v ? 1 / v : null; }
  if (cur === "GBP") { const s = await dailySeries("EURGBP=X"); const v = valueOn(s, day); return v ? 1 / v : null; }
  // Cripto: su par en euros (o en dólares pasado a euros)
  const sym = YF_ALIAS[`${cur}-EUR`] || `${cur}-EUR`;
  const s = await dailySeries(sym);
  const v = valueOn(s, day);
  if (v == null) return null;
  if (s.currency && s.currency !== "EUR") { const fx = await eurPerOn(s.currency, day); return fx ? v * fx : null; }
  return v;
}

/** Coste medio en EUR de un activo a partir de su historial completo de Revolut X. */
export async function costBasis(asset, txs) {
  const rows = txs.filter((t) => t.status === "completed").sort((x, y) => tsMs(x.created_date) - tsMs(y.created_date));
  let qty = 0, cost = 0, estimated = false, rewardQty = 0, rewardEur = 0, buys = 0;
  const lots = [];
  const reduce = (q, d) => { if (qty <= 0) return; const r = Math.min(qty, q); cost -= cost * (r / qty); qty -= r; lots.push({ d, q: -r }); };
  for (const t of rows) {
    const ms = tsMs(t.created_date), day = dayOf(ms), d = new Date(ms).toISOString();
    const src = t.source, dst = t.destination;
    const inAsset = dst?.currency?.toUpperCase() === asset, outAsset = src?.currency?.toUpperCase() === asset;
    if (t.type === "stake" || t.type === "un_stake") continue; // sigue siendo suyo (el saldo lo incluye)
    if (inAsset && (t.type === "buy" || t.type === "sell")) {
      // Compra (o venta de otra cosa a cambio de este activo): coste = lo pagado, en euros del día
      const q = num(dst.amount), paid = num(src?.amount);
      const rate = src ? await eurPerOn(src.currency, day) : null;
      let c = rate != null ? paid * rate : null;
      if (c == null) { const px = await eurPerOn(asset, day); c = px != null ? q * px : 0; estimated = true; }
      qty += q; cost += c; buys++; lots.push({ d, q });
    } else if (inAsset && t.type === "receive") {
      // Traspaso desde la app de Revolut u otra cartera: al precio de mercado de ese día
      const q = num(dst.amount), px = await eurPerOn(asset, day);
      qty += q; cost += px != null ? q * px : 0; estimated = true; lots.push({ d, q });
    } else if (inAsset && t.type === "reward") {
      const q = num(dst.amount), px = await eurPerOn(asset, day);
      qty += q; rewardQty += q; rewardEur += px != null ? q * px : 0; lots.push({ d, q });
    } else if (outAsset && ["sell", "buy", "send"].includes(t.type)) {
      reduce(num(src.amount), d);
    }
  }
  return { qty, cost, estimated, rewardQty, rewardEur, buys, lots };
}

/** Precios en vivo de Revolut X: TODOS los pares en una llamada (filtrar por nombre falla si el formato
 *  del par no coincide o si uno no existe). Devuelve { "BTC-EUR": {...}, ... } y el error si lo hay. */
export function liveTickers() {
  const out = {};
  try {
    const raw = JSON.parse(revx(["market", "tickers", "--json"]));
    for (const t of raw?.data || (Array.isArray(raw) ? raw : [])) {
      const sym = String(t.symbol || "").toUpperCase().replace(/[/_]/, "-");
      const mid = num(t.mid) || (num(t.bid) && num(t.ask) ? (num(t.bid) + num(t.ask)) / 2 : num(t.last_price));
      if (!sym.includes("-") || !mid) continue;
      out[sym] = { price: mid, bid: num(t.bid) || null, ask: num(t.ask) || null, last: num(t.last_price) || null,
        // price_change_24h es la variación ABSOLUTA en la divisa del par (p. ej. 939,15 € en BTC/EUR)
        change24h: t.price_change_24h != null && num(t.last_price) - num(t.price_change_24h) > 0 ? num(t.price_change_24h) / (num(t.last_price) - num(t.price_change_24h)) : null };
    }
    return { tickers: out };
  } catch (e) { return { tickers: out, error: String(e.stderr || e.message).replace(/s+/g, " ").slice(0, 160) }; }
}

/**
 * Sincroniza Revolut X. Devuelve el bloque `crypto` del estado.
 * `prev` es el bloque anterior: si la CLI falla, se conserva marcado como desfasado.
 */
export async function syncRevx(prev, now = new Date()) {
  const at = now.toISOString();
  let balances;
  try {
    const raw = JSON.parse(revx(["account", "balances", "--json"]));
    balances = Array.isArray(raw) ? raw : raw.balances || raw.data || [];
  } catch (e) {
    const err = String(e.stderr || e.message || e).replace(/\s+/g, " ").trim().slice(0, 300);
    if (prev?.assets) return { ...prev, stale: true, lastError: err, failedAt: at, failures: (prev.failures || 0) + 1 };
    return { configured: false, at, error: err };
  }
  const assets = balances.map((b) => {
    const total = num(b.total ?? num(b.available) + num(b.reserved)), staked = num(b.staked);
    return { asset: String(b.currency || b.asset || "").toUpperCase(), qty: total + staked, ...(staked ? { staked } : {}) };
  }).filter((a) => a.asset && a.qty > 0);

  const diag = { balances: assets.length, tx: {}, errors: [] };
  for (const a of assets) {
    if (FIAT.has(a.asset)) continue;
    try {
      const tx = JSON.parse(revx(["transaction", "list", "--currencies", a.asset, "--start-date", "1825d", "--limit", "5000", "--json"]));
      const list = tx.data || (Array.isArray(tx) ? tx : []);
      diag.tx[a.asset] = list.reduce((m, t) => ((m[t.type] = (m[t.type] || 0) + 1), m), {});
      const cb = await costBasis(a.asset, list);
      if (cb.lots.length) a.lots = cb.lots;
      if (cb.qty > 0 && cb.cost > 0) {
        const avg = cb.cost / cb.qty;
        a.avgEur = Math.round(avg * 100) / 100;
        a.costEur = Math.round(avg * a.qty * 100) / 100; // coste del saldo real
        if (cb.estimated) a.costEstimated = true;
        if (cb.buys) a.buys = cb.buys;
      }
      const gap = a.qty ? (a.qty - cb.qty) / a.qty : 0;
      const onlyRewards = list.length > 0 && list.every((t) => t.type === "reward");
      // Criptos regaladas (recompensas, airdrops): no tienen coste y su saldo no tiene por qué cuadrar
      if (onlyRewards) { a.reward = true; a.rewardUsd = a.rewardEur ?? 0; }
      else if (Math.abs(gap) > 0.005) a.qtyGap = Math.round(gap * 1000) / 1000; // el historial no explica todo el saldo
      if (cb.rewardQty > 0) { a.rewardQty = cb.rewardQty; a.rewardEur = Math.round(cb.rewardEur * 100) / 100; }
      // Solo recompensas (cursos «Aprende y gana»): sin coste
      if (!(cb.cost > 0) && cb.rewardQty > 0) { a.reward = true; a.rewardUsd = a.rewardEur; }
    } catch (e) { diag.errors.push(`${a.asset}: ${String(e.stderr || e.message).replace(/\s+/g, " ").slice(0, 120)}`); }
  }
  // Precio en vivo de Revolut X: par en EUR y, si no existe, en USD
  const { tickers: live, error: liveErr } = liveTickers();
  if (liveErr) diag.liveError = liveErr;
  let usdEur = null;
  for (const a of assets) {
    if (FIAT.has(a.asset)) continue;
    const e = live[`${a.asset}-EUR`], u = live[`${a.asset}-USD`];
    if (e) a.live = { priceEur: e.price, pair: `${a.asset}-EUR`, change24h: e.change24h, at };
    else if (u || live[`${a.asset}-USDC`] || live[`${a.asset}-USDT`]) {
      const uu = u || live[`${a.asset}-USDC`] || live[`${a.asset}-USDT`];
      if (usdEur == null) usdEur = await eurPerOn("USD", dayOf(now.getTime()));
      if (usdEur) a.live = { priceEur: uu.price * usdEur, pair: `${a.asset}-USD`, change24h: uu.change24h, at };
    }
  }
  diag.live = Object.keys(live).length;
  return { configured: true, at, assets, diag };
}
