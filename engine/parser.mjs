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

/** Acciones europeas (p. ej. TPG0) no cotizan en Yahoo con el ticker de Revolut: se busca su símbolo
 *  (XETRA primero) y se recuerda en s.settings.map, que también usa la app. */
export async function resolveTickers(s, rows) {
  s.settings = s.settings || {};
  const map = (s.settings.map = s.settings.map || {});
  const seen = new Map();
  for (const r of rows || []) if (r.t && !map[r.t] && r.cur && r.cur !== "USD") seen.set(r.t, r.cur);
  const found = [];
  for (const [sym, cur] of seen) {
    try {
      const res = await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(sym)}&quotesCount=10&newsCount=0`, { headers: { "User-Agent": "Mozilla/5.0" } });
      const q = ((await res.json()).quotes || []).filter((x) => x.quoteType === "EQUITY" || x.quoteType === "ETF");
      const pref = cur === "EUR" ? [".DE", ".AS", ".PA", ".MI", ".MC", ".F"] : cur === "GBP" ? [".L"] : [""];
      const pick = pref.map((suf) => q.find((x) => x.symbol.toUpperCase() === (sym + suf).toUpperCase())).find(Boolean) || q.find((x) => x.symbol.split(".")[0].toUpperCase() === sym.toUpperCase());
      if (pick) { map[sym] = pick.symbol; found.push(`${sym}→${pick.symbol}`); }
    } catch { /* se reintenta en la próxima pasada */ }
  }
  Object.assign(tickerMap, map);
  return found;
}
