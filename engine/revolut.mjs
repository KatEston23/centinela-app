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
// Desde servidores (GitHub Actions) la web de Revolut responde 403: se lee la ficha a través de r.jina.ai,
// un lector público de páginas (gratis, unas 20 lecturas por minuto). Desde casa basta con curl.
const ON_SERVER = !!process.env.GITHUB_ACTIONS;
async function jinaStatus(url) {
  try {
    const res = await fetch("https://r.jina.ai/" + url, { headers: { "X-Timeout": "25" }, signal: AbortSignal.timeout(40000) });
    if (!res.ok) return 0;
    const t = (await res.text()).slice(0, 1500);
    if (/returned error 404|can.t find that one/i.test(t)) return 404;
    if (/^Title: .*| Revolut/m.test(t)) return 200;
    return 0;
  } catch { return 0; }
}
const statusOf = async (url) => {
  if (!ON_SERVER) { const st = await curlStatus(url); if (st === 200 || st === 404) return st; }
  return jinaStatus(url);
};
// Criptos que se negocian en Revolut X (las del universo del escáner y las de su cartera)
const REVX = new Set(["BTC", "ETH", "SOL", "XRP", "ADA", "DOGE", "DOT", "LINK", "AVAX", "LTC", "MON", "POL", "UNI", "ATOM", "XLM", "SHIB", "PEPE"]);

export async function checkRevolut(s, syms, now = new Date(), max = 40, delay = ON_SERVER ? 3200 : 350) {
  s.revolut = s.revolut || {};
  let checked = 0, blocked = 0;
  for (const sym of [...new Set(syms)]) {
    if (/-(EUR|USD)$/.test(sym)) { s.revolut[sym] = { ok: REVX.has(sym.replace(/-(EUR|USD)$/, "")), at: now.toISOString() }; continue; }
    const c = s.revolut[sym];
    if (c && c.ok != null && now - new Date(c.at) < (c.ok ? 14 : 5) * 864e5) continue;
    if (checked >= max || blocked >= 4) continue;
    try {
      const url = `https://www.revolut.com/en-GB/stocks/${encodeURIComponent(sym.toLowerCase())}/`;
      let status = await statusOf(url);
      // Respuesta rara (límite de peticiones, corte): se espera y se reintenta una vez
      if (status !== 200 && status !== 404) { await new Promise((res) => setTimeout(res, 6000)); status = await statusOf(url); }
      const r = { status };
      checked++;
      if (r.status === 200) s.revolut[sym] = { ok: true, at: now.toISOString() };
      else if (r.status === 404) s.revolut[sym] = { ok: false, at: now.toISOString() };
      else blocked++;
    } catch { blocked++; }
    await new Promise((res) => setTimeout(res, delay));
  }
  return { checked, blocked };
}
/** true = se puede comprar, false = no está en Revolut, undefined = sin comprobar */
export const onRevolut = (s, sym) => s.revolut?.[sym]?.ok;

// Lista de partida comprobada desde el PC (ai/revolut.json): el motor la suma y la va ampliando él solo.
export const REV_FILE = join(ROOT, "ai", "revolut.json");
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
