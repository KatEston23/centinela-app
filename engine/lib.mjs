// Utilidades compartidas del motor de Centinela: precios (Yahoo Finance) e indicadores.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Configuración: config.local.json en el PC; en GitHub Actions llega por variables de entorno (Secrets)
export function loadConfig() {
  const p = join(ROOT, "config.local.json");
  const file = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  const env = process.env;
  return {
    ...file,
    ...(env.PWA_KEY ? { pwaKey: env.PWA_KEY } : {}),
    ...(env.NTFY_TOPIC ? { ntfyTopic: env.NTFY_TOPIC } : {}),
    ...(env.NTFY_SERVER ? { ntfyServer: env.NTFY_SERVER } : {}),
    pwaUrl: env.PWA_URL || "https://kateston23.github.io/centinela-app/",
  };
}

const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };

export async function fetchChart(symbol, range = "1y") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  for (let i = 0; i < 2; i++) {
    const r = await fetch(url, { headers: UA });
    if (r.ok) {
      const j = await r.json();
      const res = j?.chart?.result?.[0];
      if (!res) throw new Error(`sin datos para ${symbol}`);
      return res;
    }
    await new Promise((s) => setTimeout(s, 800));
  }
  throw new Error(`Yahoo no respondió para ${symbol}`);
}

const round = (x, d = 4) => (x == null || !isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

function sma(a, n) {
  if (a.length < n) return null;
  let s = 0;
  for (let i = a.length - n; i < a.length; i++) s += a[i];
  return s / n;
}

function rsi(a, n = 14) {
  if (a.length < n + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) {
    const d = a[i] - a[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  g /= n; l /= n;
  for (let i = n + 1; i < a.length; i++) {
    const d = a[i] - a[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n;
    l = (l * (n - 1) + Math.max(-d, 0)) / n;
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

function pct(a, back) {
  if (a.length <= back) return null;
  return a[a.length - 1] / a[a.length - 1 - back] - 1;
}

/**
 * Fase de mercado (inspirada en las fases de Wyckoff y Weinstein), solo con precio y medias:
 * acumulación → tendencia alcista → (corrección) → distribución → tendencia bajista → (rebote) → …
 */
export function marketPhase({ closes, price, s50, s200, dd, ch30, ch90 }) {
  if (!s50 || !s200 || closes.length < 230) return { code: "sin_datos", label: "Sin historia suficiente", note: "Hace falta casi un año de cotizaciones para fijar la fase." };
  const s200prev = sma(closes.slice(0, -20), 200), s50prev = sma(closes.slice(0, -20), 50);
  const slope200 = s200prev ? s200 / s200prev - 1 : 0;   // pendiente de la media de 200 en 20 sesiones
  const slope50 = s50prev ? s50 / s50prev - 1 : 0;
  const near200 = Math.abs(price / s200 - 1) < 0.05;
  const up200 = slope200 > 0.005, down200 = slope200 < -0.005, flat200 = !up200 && !down200;
  const P = (code, label, note) => ({ code, label, note });
  if (price > s50 && s50 > s200 && up200 && dd > -0.08 && (ch90 ?? 0) > 0.25 && slope50 < 0.005)
    return P("distribucion", "Distribución (posible techo)", "Viene de una fuerte subida y pierde impulso cerca de máximos: es fácil comprar caro.");
  if (price > s50 && s50 > s200 && up200)
    return P("alcista", "Tendencia alcista", "Precio sobre sus medias y la de 200 sube: la fase más sana para estar dentro.");
  if (price > s50 && s50 > s200 && flat200)
    return P("alcista", "Inicio de tendencia alcista", "Precio y media de 50 por encima de la de 200, que empieza a girar: tendencia que se está formando.");
  if (price > s50 && price > s200 && s50 <= s200)
    return P("acumulacion", "Recuperación (posible suelo superado)", "Vuelve por encima de sus medias tras una fase débil: podría estar saliendo del suelo, pendiente de confirmar.");
  if (price <= s50 && price > s200 * 0.97 && (up200 || flat200) && s50 > s200)
    return P("correccion", "Corrección en tendencia alcista", "Retrocede sin romper la tendencia de fondo: suele ofrecer los mejores puntos de entrada.");
  if (price < s50 && s50 < s200 && down200)
    return P("bajista", "Tendencia bajista", "Precio bajo sus medias y la de 200 cae: entrar aquí es intentar coger un cuchillo que cae.");
  if (price > s50 && price < s200 && down200)
    return P("rebote", "Rebote en tendencia bajista", "Rebota, pero la tendencia de fondo sigue siendo bajista: hace falta confirmación.");
  if ((near200 || flat200) && dd < -0.15 && (ch30 ?? 0) > -0.06)
    return P("acumulacion", "Acumulación (posible suelo)", "Tras una caída, el precio se estabiliza en torno a su media de 200: puede estar formando suelo.");
  if (price < s200 && (down200 || flat200))
    return P("debil", "Débil, bajo su media de 200", "Por debajo de su tendencia de fondo y sin señales claras de giro.");
  return P("lateral", "Lateral", "Sin una tendencia clara: el precio oscila sin dirección definida.");
}

/** Analiza un símbolo: precio, variaciones, RSI, medias, volatilidad, deriva, disparadores. */
/** Precio fuera de horario (preapertura / cierre ampliado) del último minuto con cotización, o null. */
export async function extendedQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m&includePrePost=true`;
  const r = await fetch(url, { headers: UA });
  if (!r.ok) return null;
  const res = (await r.json())?.chart?.result?.[0];
  const m = res?.meta, ts = res?.timestamp || [], c = res?.indicators?.quote?.[0]?.close || [];
  if (!m || m.instrumentType === "CRYPTOCURRENCY") return null;
  let i = c.length - 1;
  while (i >= 0 && c[i] == null) i--;
  if (i < 0 || !m.regularMarketTime || ts[i] <= m.regularMarketTime + 120) return null; // en sesión: ya vale el precio normal
  const reg = m.currentTradingPeriod?.regular;
  const session = reg && ts[i] < reg.start && ts[i] > reg.start - 12 * 3600 ? "pre" : "post";
  return { price: c[i], at: ts[i], session };
}

export async function analyze(symbol, opts = {}) {
  const res = await fetchChart(symbol);
  const m = res.meta;
  const ts = res.timestamp || [];
  const raw = res.indicators?.quote?.[0]?.close || [];
  const vols = res.indicators?.quote?.[0]?.volume || [];
  const rows = ts.map((t, i) => [t, raw[i], vols[i]]).filter((r) => r[1] != null);
  const closes = rows.map((r) => r[1]);
  const regular = m.regularMarketPrice ?? closes.at(-1);
  let price = regular;
  if (closes.length) closes[closes.length - 1] = price;
  // Fuera de horario manda el precio de preapertura/cierre ampliado, como en Revolut.
  // Preapertura: es un día nuevo (se añade un punto). Cierre ampliado: prolonga el día de hoy.
  let ext = null;
  if (opts.ext) { try { ext = await extendedQuote(symbol); } catch {} }
  if (ext) {
    price = ext.price;
    if (ext.session === "pre") { closes.push(price); rows.push([ext.at, price, null]); }
    else closes[closes.length - 1] = price;
  }

  const logr = [];
  for (let i = 1; i < closes.length; i++) logr.push(Math.log(closes[i] / closes[i - 1]));
  const periods = m.instrumentType === "CRYPTOCURRENCY" ? 365 : 252;
  const mean = logr.reduce((a, b) => a + b, 0) / (logr.length || 1);
  const sd = Math.sqrt(logr.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, logr.length - 1));
  const last30 = logr.slice(-30);
  const m30 = last30.reduce((a, b) => a + b, 0) / (last30.length || 1);
  const sd30 = Math.sqrt(last30.reduce((a, b) => a + (b - m30) ** 2, 0) / Math.max(1, last30.length - 1));

  const high = Math.max(...closes), low = Math.min(...closes);
  const s50 = sma(closes, 50), s200 = sma(closes, 200);
  const r14 = rsi(closes);
  const prevClose = closes.length > 1 ? closes[closes.length - 2] : null;
  const ch1 = prevClose ? price / prevClose - 1 : null;
  const v = vols.filter((x) => x != null);
  const vAvg = v.length > 21 ? v.slice(-21, -1).reduce((a, b) => a + b, 0) / 20 : null;
  const volRatio = vAvg ? v.at(-1) / vAvg : null;

  const triggers = [];
  if (ch1 != null && Math.abs(ch1) >= 0.05) triggers.push({ code: ch1 < 0 ? "caida_dia" : "subida_dia", text: `${ch1 < 0 ? "Cae" : "Sube"} ${Math.abs(ch1 * 100).toFixed(1)} % ${ext ? (ext.session === "pre" ? "en preapertura" : "en el cierre ampliado") : "en el día"}` });
  if (r14 != null && r14 < 30) triggers.push({ code: "rsi_sobreventa", text: `RSI ${r14.toFixed(0)}: sobreventa` });
  if (r14 != null && r14 > 70) triggers.push({ code: "rsi_sobrecompra", text: `RSI ${r14.toFixed(0)}: sobrecompra` });
  if (s200 && prevClose) {
    const prevAbove = prevClose > s200, nowAbove = price > s200;
    if (prevAbove && !nowAbove) triggers.push({ code: "pierde_sma200", text: "Pierde la media de 200 sesiones" });
    if (!prevAbove && nowAbove) triggers.push({ code: "recupera_sma200", text: "Recupera la media de 200 sesiones" });
  }
  const dd = price / high - 1;
  if (dd <= -0.2) triggers.push({ code: "drawdown", text: `${(dd * 100).toFixed(0)} % desde el máximo de 52 semanas` });
  if (volRatio && volRatio >= 2) triggers.push({ code: "volumen", text: `Volumen ×${volRatio.toFixed(1)} sobre su media` });

  // Historial reducido para gráficas: [día unix, cierre]
  const history = rows.map((r, i) => [Math.floor(r[0] / 86400), round(i === rows.length - 1 ? price : r[1], 4)]);
  const phase = marketPhase({ closes, price, s50, s200, dd, ch30: pct(closes, 21), ch90: pct(closes, 63) });

  return {
    phase: phase.code,
    phaseLabel: phase.label,
    phaseNote: phase.note,
    symbol,
    name: m.longName || m.shortName || symbol,
    kind: m.instrumentType === "CRYPTOCURRENCY" ? "crypto" : m.instrumentType === "ETF" ? "etf" : "stock",
    exchange: m.fullExchangeName || m.exchangeName || "",
    currency: m.currency,
    price: round(price, 4),
    ...(ext ? { regularPrice: round(regular, 4), extSession: ext.session, extAt: new Date(ext.at * 1000).toISOString() } : {}),
    change1d: round(ch1),
    change7d: round(pct(closes, 5)),
    change30d: round(pct(closes, 21)),
    change90d: round(pct(closes, 63)),
    high52: round(high, 4),
    low52: round(low, 4),
    drawdown: round(dd),
    rsi14: round(r14, 1),
    sma50: round(s50, 4),
    sma200: round(s200, 4),
    volAnnual: round(sd * Math.sqrt(periods)),
    vol30: round(sd30 * Math.sqrt(periods)),
    muAnnual: round(mean * periods),
    volumeRatio: round(volRatio, 2),
    triggers,
    history,
    marketTime: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null,
  };
}

export async function fxEurPer(currency) {
  if (!currency || currency === "EUR") return 1;
  const r = await fetchChart(`EUR${currency}=X`, "5d");
  return 1 / r.meta.regularMarketPrice; // EUR por 1 unidad de la divisa
}

export async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k]); } catch (e) { out[k] = { symbol: items[k], error: String(e.message || e) }; }
    }
  }));
  return out;
}
