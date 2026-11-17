// ¿Se puede comprar en Revolut? Revolut no publica la lista, pero tiene una ficha pública por cada acción
// que ofrece (revolut.com/en-GB/stocks/<ticker>/): 200 = disponible, 404 = no. Se usa el catálogo de Reino
// Unido como referencia (el de Irlanda/UE no tiene fichas públicas); casi siempre coinciden.
// Resultado en s.revolut[símbolo] = { ok: true | false, at }. Se recuerda 14 días (los «no», 5).
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib.mjs";

// Con curl: la web de Revolut rechaza el fetch de Node (403) pero no a curl
const curlStatus = (url) => new Promise((res) => execFile("curl", ["-s", "-o", process.platform === "win32" ? "NUL" : "/dev/null", "-w", "%{http_code}", "--max-time", "15",
  "-A", HEADERS["User-Agent"], "-H", "Accept: " + HEADERS.Accept, "-H", "Accept-Language: " + HEADERS["Accept-Language"], url], (err, out) => res(err ? 0 : Number(out) || 0)));
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml",
  "Accept-Language": "en-GB,en;q=0.9",
};
// Criptos que se negocian en Revolut X (las del universo del escáner y las de su cartera)
const REVX = new Set(["BTC", "ETH", "SOL", "XRP", "ADA", "DOGE", "DOT", "LINK", "AVAX", "LTC", "MON", "POL", "UNI", "ATOM", "XLM", "SHIB", "PEPE"]);

export async function checkRevolut(s, syms, now = new Date(), max = 40) {
  s.revolut = s.revolut || {};
  let checked = 0, blocked = 0;
  for (const sym of [...new Set(syms)]) {
    if (/-(EUR|USD)$/.test(sym)) { s.revolut[sym] = { ok: REVX.has(sym.replace(/-(EUR|USD)$/, "")), at: now.toISOString() }; continue; }
    const c = s.revolut[sym];
    if (c && c.ok != null && now - new Date(c.at) < (c.ok ? 14 : 5) * 864e5) continue;
    if (checked >= max || blocked >= 3) continue;
    try {
      const status = await curlStatus(`https://www.revolut.com/en-GB/stocks/${encodeURIComponent(sym.toLowerCase())}/`);
      const r = { status };
      checked++;
      if (r.status === 200) s.revolut[sym] = { ok: true, at: now.toISOString() };
      else if (r.status === 404) s.revolut[sym] = { ok: false, at: now.toISOString() };
      else blocked++;
    } catch { blocked++; }
    await new Promise((res) => setTimeout(res, 350));
  }
  return { checked, blocked };
}
/** true = se puede comprar, false = no está en Revolut, undefined = sin comprobar */
export const onRevolut = (s, sym) => s.revolut?.[sym]?.ok;

// La web de Revolut bloquea a los servidores de GitHub: la comprobación la hace una tarea del PC
// (engine/revolut-local.mjs) y deja el resultado en data/revolut.json, que el motor suma aquí.
export const REV_FILE = join(ROOT, "data", "revolut.json");
export function mergeRevolutFile(s) {
  if (!existsSync(REV_FILE)) return 0;
  s.revolut = s.revolut || {};
  let n = 0;
  try {
    const f = JSON.parse(readFileSync(REV_FILE, "utf8"));
    for (const [sym, v] of Object.entries(f.map || {})) {
      if (typeof v?.ok !== "boolean") continue;
      const c = s.revolut[sym];
      if (!c || c.ok == null || new Date(v.at) > new Date(c.at)) { s.revolut[sym] = { ok: v.ok, at: v.at }; n++; }
    }
  } catch { /* fichero dañado: se ignora */ }
  return n;
}
