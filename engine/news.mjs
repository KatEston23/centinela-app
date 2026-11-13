// Noticias reales (Google Noticias en español, sin clave) y métricas de valoración (Finnhub).
// Solo datos públicos: las búsquedas mezclan valores de la cartera, vigilancia e ideas.
import { createHash } from "node:crypto";

const UA = { "User-Agent": "Mozilla/5.0 (compatible; Centinela/1.0)" };
const unxml = (x) => String(x || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).trim();

export async function googleNews(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=es&gl=ES&ceid=ES:es`;
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error("Google Noticias " + r.status);
  const xml = await r.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, it]) => {
    const g = (tag) => unxml((it.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1]);
    const src = g("source");
    let t = g("title");
    if (src && t.endsWith(" - " + src)) t = t.slice(0, -(src.length + 3));
    const d = new Date(g("pubDate"));
    return { t, src, u: g("link"), at: isNaN(d) ? null : d.toISOString() };
  }).filter((x) => x.t && x.u && /^https:\/\//.test(x.u) && x.at);
}

// Temas del canal de noticias
export const TOPICS = [
  { cat: "ipo", q: '"salida a bolsa" OR OPV OR "debut bursátil" OR "debut en bolsa" OR IPO when:3d' },
  { cat: "revolut", q: 'Revolut (acciones OR OPV OR "salida a bolsa" OR "invertir en") when:7d' },
  { cat: "mercado", q: '"Wall Street" OR Nasdaq OR "S&P 500" OR "Reserva Federal" when:1d' },
  { cat: "europa", q: '"Ibex 35" OR "bolsas europeas" OR BCE OR "Euro Stoxx" when:1d' },
  { cat: "cripto", q: "bitcoin OR criptomonedas OR ethereum when:1d" },
];
const IPO_RE = /salida a bolsa|\bOPV\b|\bIPO\b|debut(a|ar|ó)? (bursátil|en (bolsa|el Nasdaq|Wall Street|la bolsa))|empieza a cotizar|comienza a cotizar|cotizar por primera vez|pre-?IPO/i;
const CRYPTO_NAMES = { BTC: "bitcoin", ETH: "ethereum", SOL: "solana", XRP: "XRP", ADA: "cardano", DOGE: "dogecoin" };

/** Nombre buscable de un valor: «NVIDIA Corporation» → «NVIDIA», «BTC-EUR» → «bitcoin». */
export function searchName(sym, name) {
  const base = sym.replace(/-(EUR|USD)$/, "");
  if (/-(EUR|USD)$/.test(sym)) return CRYPTO_NAMES[base] || base;
  let n = String(name || base).replace(/\(.*?\)/g, " ")
    .replace(/\b(Corporation|Corp\.?|Incorporated|Inc\.?|plc|p\.l\.c\.|S\.A\.?|SA|N\.V\.|NV|Ltd\.?|Limited|Holdings?|Group|Company|Co\.|AG|SE|PBC|Class [A-Z]|Common Stock|ADR|ordinary shares)\b/gi, " ")
    .replace(/[,.]+$/g, "").replace(/\s+/g, " ").trim();
  return n.length >= 3 ? n : base;
}

const idOf = (t) => createHash("sha1").update(t.toLowerCase().replace(/\W+/g, "")).digest("hex").slice(0, 12);

/**
 * Actualiza s.news con los temas generales y las noticias de cada valor.
 * symbols: [{ sym, name }]. Conserva 72 h y como mucho 220 titulares.
 */
export async function refreshNews(s, symbols, mapLimit, now = new Date()) {
  const prev = new Map((s.news?.items || []).map((x) => [x.id, x]));
  const out = new Map(prev);
  const add = (x, cat, sym) => {
    const id = idOf(x.t);
    const it = out.get(id) || { id, t: x.t.slice(0, 220), src: x.src.slice(0, 60), u: x.u, at: x.at, cats: [], syms: [], seen: now.toISOString() };
    if (cat && !it.cats.includes(cat)) it.cats.push(cat);
    if (sym && !it.syms.includes(sym)) it.syms.push(sym);
    if (IPO_RE.test(it.t) && !it.cats.includes("ipo")) it.cats.push("ipo");
    if (/revolut/i.test(it.t) && !it.cats.includes("revolut")) it.cats.push("revolut");
    out.set(id, it);
  };
  let errors = 0;
  await mapLimit(TOPICS, 3, async (tp) => {
    try { for (const x of (await googleNews(tp.q)).slice(0, 25)) add(x, tp.cat); } catch { errors++; }
  });
  await mapLimit(symbols, 4, async ({ sym, name }) => {
    const n = searchName(sym, name);
    const q = /-(EUR|USD)$/.test(sym) ? `${n} when:2d` : `"${n}" (bolsa OR acciones OR empresa OR CEO OR resultados) when:2d`;
    try { for (const x of (await googleNews(q)).slice(0, 8)) add(x, "valor", sym); } catch { errors++; }
  });
  const cutoff = now.getTime() - 72 * 3600e3;
  const items = [...out.values()].filter((x) => new Date(x.at).getTime() > cutoff && new Date(x.at).getTime() <= now.getTime() + 600e3)
    .sort((a, b) => b.at.localeCompare(a.at)).slice(0, 220);
  const fresh = items.filter((x) => !prev.has(x.id)).length;
  s.news = { at: now.toISOString(), items };
  return { total: items.length, fresh, errors };
}

/** Métricas de valoración (Finnhub, plan gratuito: acciones de EE. UU.). Una vez al día por valor. */
export async function refreshFundamentals(s, syms, key, now = new Date()) {
  if (!key) return { done: 0 };
  s.fund = s.fund || {};
  let done = 0;
  for (const sym of syms) {
    if (/-(EUR|USD)$|^\^|=/.test(sym)) continue;
    const f = s.fund[sym];
    if (f && now - new Date(f.at) < 20 * 3600e3) continue;
    if (done >= 30) break;
    try {
      const r = await fetch(`https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(sym)}&metric=all&token=${encodeURIComponent(key)}`);
      if (r.status === 429) break;
      const m = (await r.json())?.metric || {};
      const num = (v) => (v == null || !isFinite(v) ? null : Math.round(Number(v) * 100) / 100);
      s.fund[sym] = {
        at: now.toISOString(),
        pe: num(m.peTTM ?? m.peBasicExclExtraTTM), ps: num(m.psTTM), pb: num(m.pbQuarterly ?? m.pbAnnual),
        revG: num(m.revenueGrowthTTMYoy), epsG: num(m.epsGrowthTTMYoy), margin: num(m.netProfitMarginTTM),
        divY: num(m.dividendYieldIndicatedAnnual), beta: num(m.beta), hi52: num(m["52WeekHigh"]), lo52: num(m["52WeekLow"]),
      };
      done++;
      await new Promise((res) => setTimeout(res, 1100)); // 60 consultas/min como máximo
    } catch { /* sin datos: se reintenta otro día */ }
  }
  return { done };
}
