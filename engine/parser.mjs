// Reutiliza EXACTAMENTE el lector de extractos y el cálculo de posiciones de la dashboard
// (se extraen de web/centinela.html para no tener dos versiones de la misma lógica).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib.mjs";

const html = readFileSync(join(ROOT, "web", "centinela.html"), "utf8");
const src = html.split("<script>")[1].split("</script>")[0];
const grab = (n) => {
  const i = src.indexOf("function " + n + "(");
  if (i < 0) throw new Error("No encuentro " + n + " en centinela.html");
  let d = 0;
  for (let k = src.indexOf("{", i); k < src.length; k++) { if (src[k] === "{") d++; if (src[k] === "}" && !--d) return src.slice(i, k + 1); }
};
const S = { settings: { map: {} } };
export const { importRevolut, holdingsFromLedger } = new Function("S",
  ["splitCSV", "parseNum", "parseDate", "curOf", "importRevolut", "holdingsFromLedger"].map(grab).join("\n") +
  "\nreturn { importRevolut, holdingsFromLedger };")(S);
// Ticker de Revolut → símbolo de Yahoo (el motor lo rellena desde s.settings.map antes de calcular)
export const tickerMap = S.settings.map;

/** Acciones europeas (p. ej. TPG0, SND) no cotizan en Yahoo con el ticker de Revolut: se busca su símbolo
 *  y se recuerda en s.settings.map, que también usa la app.
 *  Ojo: el mismo ticker puede ser otra empresa en EE. UU. (SND = Schneider Electric en Xetra, pero Smart Sand
 *  en el Nasdaq). Por eso solo se acepta una cotización en la MISMA divisa que la compra, se prueban primero
 *  las bolsas europeas directamente (la búsqueda de Yahoo no siempre las devuelve) y se revisan los mapeos
 *  ya guardados que apunten a una cotización en otra divisa. */
const UA = { "User-Agent": "Mozilla/5.0" };
async function chartMeta(sym) {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`, { headers: UA });
    if (!r.ok) return null;
    return (await r.json())?.chart?.result?.[0]?.meta || null;
  } catch { return null; }
}
export async function resolveTickers(s, rows) {
  s.settings = s.settings || {};
  const map = (s.settings.map = s.settings.map || {});
  const curOf = new Map(), avgOf = new Map();
  for (const r of rows || []) if (r.t && r.cur && r.cur !== "USD") { curOf.set(r.t, r.cur); if (r.k === "buy" && r.p) avgOf.set(r.t, r.p); }
  const found = [];
  for (const [sym, cur] of curOf) {
    const cached = map[sym];
    if (cached && !s.settings.mapChecked?.[sym]) {
      // Mapeo antiguo: se comprueba una vez que su divisa sea la de la compra
      const m = await chartMeta(cached);
      s.settings.mapChecked = { ...(s.settings.mapChecked || {}), [sym]: true };
      if (m && m.currency === cur) continue;
      delete map[sym]; (s._staleQuotes = s._staleQuotes || []).push(cached); found.push(`${sym}: ${cached} descartado (cotiza en ${m?.currency || "?"}, la compra fue en ${cur})`);
    } else if (cached) continue;
    const pref = cur === "EUR" ? [".DE", ".PA", ".AS", ".MI", ".MC", ".BR", ".LS", ".F"] : cur === "GBP" ? [".L"] : cur === "CHF" ? [".SW"] : [""];
    let pick = null;
    for (const suf of pref) {
      const m = await chartMeta(sym + suf);
      if (!m || m.currency !== cur || !m.regularMarketPrice) continue;
      // Precio razonable frente al de compra (descarta otra empresa con el mismo ticker)
      const p = avgOf.get(sym);
      if (p && (m.regularMarketPrice / p > 5 || m.regularMarketPrice / p < 0.05)) continue;
      pick = sym + suf; break;
    }
    if (!pick) {
      try {
        const res = await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(sym)}&quotesCount=10&newsCount=0`, { headers: UA });
        const q = ((await res.json()).quotes || []).filter((x) => (x.quoteType === "EQUITY" || x.quoteType === "ETF") && x.symbol.includes("."));
        for (const c of q) { const m = await chartMeta(c.symbol); if (m?.currency === cur) { pick = c.symbol; break; } }
      } catch { /* se reintenta en la próxima pasada */ }
    }
    if (pick) { map[sym] = pick; s.settings.mapChecked = { ...(s.settings.mapChecked || {}), [sym]: true }; found.push(`${sym}→${pick}`); }
  }
  Object.assign(tickerMap, map);
  // Lo descartado deja de estar en el mapa compartido
  for (const k of Object.keys(tickerMap)) if (!(k in map)) delete tickerMap[k];
  return found;
}
