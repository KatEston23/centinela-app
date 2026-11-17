// Alto riesgo: valores muy castigados que empiezan a girar y grandes subidas del día.
// Fuente: listas públicas de Yahoo Finance (más suben, más bajan, más negociadas, pequeñas empresas)
// más los castigados del universo del escáner. Se analiza cada hora; nunca opera.

import { checkRevolut } from "./revolut.mjs";

const UA = { "User-Agent": "Mozilla/5.0 (compatible; Centinela/1.0)" };
const SCREENS = ["day_gainers", "small_cap_gainers", "most_actives", "day_losers", "undervalued_growth_stocks"];
const POOL_DAYS = 14, POOL_MAX = 45, MIN_CAP = 300e6, MIN_PRICE = 1;

async function screener(id) {
  const r = await fetch(`https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=${id}&count=25`, { headers: UA });
  if (!r.ok) throw new Error(`${id} ${r.status}`);
  return (await r.json())?.finance?.result?.[0]?.quotes || [];
}

// Solo acciones de bolsas de EE. UU. (Nasdaq/NYSE), con algo de tamaño: así es más probable que estén en Revolut
const usable = (x) => x.quoteType === "EQUITY" && /^(Nasdaq|NYSE)/i.test(x.fullExchangeName || "") && /^[A-Z]{1,5}$/.test(x.symbol)
  && (x.regularMarketPrice ?? 0) >= MIN_PRICE && (x.marketCap ?? 0) >= MIN_CAP;

/** Añade símbolos a la reserva de candidatas (se olvidan a los 14 días sin aparecer). */
export function addToPool(s, syms, from, now = new Date()) {
  s.spec = s.spec || { items: [] };
  const pool = (s.spec.pool = s.spec.pool || {});
  for (const sym of syms) pool[sym] = { first: pool[sym]?.first || now.toISOString(), last: now.toISOString(), from };
}

const avg = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const pc = (v) => `${v > 0 ? "+" : ""}${Math.round(v * 100).toLocaleString("es-ES")} %`;

/** Clasifica un valor analizado. Devuelve null si no es ni rebote ni despegue. */
export function classify(q) {
  if (!q || q.error || q.price == null) return null;
  const closes = (q.history || []).map((h) => h[1]);
  const ma10 = closes.length >= 10 ? avg(closes.slice(-10)) : null;
  const dd = q.drawdown ?? 0, rsi = q.rsi14, ch1 = q.change1d ?? 0, ch7 = q.change7d ?? 0, vr = q.volumeRatio;
  const low = q.low52 ? q.price / q.low52 - 1 : null;
  const notes = [];
  if (q.price < 5) notes.push("acción de pocos dólares: se mueve a saltos");
  if ((q.vol30 ?? 0) > 1) notes.push(`muy volátil (oscila un ${Math.round(q.vol30 * 100)} % al año)`);
  if (ch1 >= 0.15 && (vr == null || vr >= 2)) {
    return { type: "despegue", rank: ch1, title: `Sube ${pc(ch1)} hoy`,
      why: `Sube ${pc(ch1)} en el día${vr ? ` con un volumen ${vr.toFixed(1).replace(".", ",")} veces el normal` : ""}${low != null && low > 1 ? `; está un ${pc(low)} por encima de su mínimo del año` : ""}.`,
      risk: "Llega tarde: ya ha subido. Estos saltos suelen venir de una noticia puntual (resultados, un ensayo clínico, una compra) y a menudo devuelven parte en los días siguientes.", notes };
  }
  if (dd <= -0.4 && rsi != null && rsi >= 30 && rsi <= 58 && ch7 >= 0.03 && ma10 && q.price > ma10) {
    return { type: "rebote", rank: -dd + ch7, title: `Castigada que empieza a girar`,
      why: `Está un ${pc(-dd).replace("+", "")} por debajo de su máximo de 52 semanas y gira al alza: ${pc(ch7)} en una semana, por encima de su media de 10 días, RSI ${Math.round(rsi)}.`,
      risk: "Un rebote dentro de una caída larga puede quedarse en nada si el negocio sigue mal: mire por qué cayó antes de entrar.", notes };
  }
  if (dd <= -0.35 && rsi != null && rsi < 30) {
    return { type: "sobreventa", rank: -dd + (30 - rsi) / 100, title: `Muy castigada, en sobreventa`,
      why: `Cae un ${pc(-dd).replace("+", "")} desde su máximo de 52 semanas y su RSI es ${Math.round(rsi)} (sobreventa extrema): zona donde a veces rebota.`,
      risk: "Aún no hay señal de giro: «barata» puede abaratarse más. Mejor esperar a que empiece a subir.", notes };
  }
  return null;
}

/**
 * Actualiza s.spec (cada hora): reserva de candidatas y las que hoy cumplen las reglas.
 * exclude: símbolos que el usuario ya tiene (no se proponen).
 */
export async function refreshMovers(s, { analyze, mapLimit, exclude = new Set(), now = new Date() }) {
  s.spec = s.spec || { items: [] };
  if (s.spec.at && now - new Date(s.spec.at) < 55 * 60e3) return { skipped: true };
  let errors = 0, seen = 0;
  const lists = await mapLimit(SCREENS, 3, async (id) => { try { return await screener(id); } catch { errors++; return []; } });
  const meta = {};
  for (const [i, list] of lists.entries()) {
    const ok = list.filter(usable);
    seen += ok.length;
    for (const x of ok) meta[x.symbol] = { cap: x.marketCap };
    addToPool(s, ok.map((x) => x.symbol), SCREENS[i], now);
  }
  // Olvida lo que lleva 14 días sin aparecer; analiza primero lo más reciente
  const pool = s.spec.pool || {};
  for (const [k, v] of Object.entries(pool)) if (now - new Date(v.last) > POOL_DAYS * 864e5) delete pool[k];
  const syms = Object.entries(pool).filter(([k]) => !exclude.has(k)).sort((a, b) => b[1].last.localeCompare(a[1].last)).slice(0, POOL_MAX).map(([k]) => k);
  const rows = await mapLimit(syms, 6, async (sym) => { try { return await analyze(sym); } catch (e) { return { symbol: sym, error: e.message }; } });
  const prev = new Map((s.spec.items || []).map((i) => [i.symbol, i]));
  const picked = [];
  for (const q of rows) {
    const c = classify(q);
    if (!c) continue;
    const p = prev.get(q.symbol);
    const ai = p?.aiAt && now - new Date(p.aiAt) < 36 * 3600e3 ? { verdict: p.verdict, confidence: p.confidence, aiReason: p.aiReason, news: p.news, aiRisk: p.aiRisk, aiAt: p.aiAt } : {};
    picked.push({
      symbol: q.symbol, name: q.name, exchange: q.exchange, currency: q.currency, price: q.price, kind: q.kind,
      change1d: q.change1d, change7d: q.change7d, change30d: q.change30d, drawdown: q.drawdown, rsi14: q.rsi14, volumeRatio: q.volumeRatio,
      high52: q.high52, low52: q.low52, sma50: q.sma50, sma200: q.sma200, phase: q.phase, phaseLabel: q.phaseLabel, vol30: q.vol30,
      cap: meta[q.symbol]?.cap ?? p?.cap ?? null, from: pool[q.symbol]?.from, since: p?.type === c.type ? p.since : now.toISOString(),
      type: c.type, title: c.title, why: c.why, risk: c.risk, notes: c.notes, rank: c.rank,
      spark: (q.history || []).slice(-90).map((h) => h[1]), ...ai,
    });
  }
  // Solo lo que se puede comprar en Revolut (lo que no se ha podido comprobar se queda, marcado)
  const rv = await checkRevolut(s, picked.sort((a, b) => b.rank - a.rank).map((x) => x.symbol), now, 25);
  const buyable = picked.filter((x) => s.revolut?.[x.symbol]?.ok !== false);
  for (const x of buyable) x.revolut = s.revolut?.[x.symbol]?.ok ?? null;
  // Como mucho 4 de cada tipo y 10 en total, lo más destacado primero
  const by = (t) => buyable.filter((x) => x.type === t).sort((a, b) => b.rank - a.rank).slice(0, 4);
  s.spec.items = [...by("despegue"), ...by("rebote"), ...by("sobreventa")].slice(0, 10);
  s.spec.at = now.toISOString();
  s.spec.analyzed = rows.filter((r) => r && !r.error).length;
  return { pool: Object.keys(pool).length, analyzed: s.spec.analyzed, items: s.spec.items.length, seen, errors, notInRevolut: picked.length - buyable.length, rvChecked: rv.checked, rvBlocked: rv.blocked };
}
