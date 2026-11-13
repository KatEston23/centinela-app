// Motor base de Centinela (capa 1): funciona sin PC y sin tokens, en GitHub Actions.
//   node engine/cloud-run.mjs portfolio   → saldos de Revolut X, precios, señales por reglas y avisos
//   node engine/cloud-run.mjs scan        → lo anterior + escáner técnico del universo
// Trabaja sobre out/state.json (lo deja `node engine/state.mjs decrypt`); después se publica con
// `node engine/state.mjs publish`. El análisis de noticias lo añade la capa 2 (Claude) cuando hay tokens.
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT, analyze, fxEurPer, mapLimit, loadConfig } from "./lib.mjs";
// notify() y los helpers de duplicados se usan también en la capa 2 (más abajo)
import { UNIVERSE } from "./universe.mjs";
import { refreshNews, refreshFundamentals } from "./news.mjs";
import { sendPush, vapidPublic } from "./webpush.mjs";
import { holdingsFromLedger } from "./parser.mjs";
import { readState, writeState, decrypt } from "./state.mjs";

const mode = process.argv[2] || "portfolio";
const cfg = loadConfig();
const now = new Date();
const at = now.toISOString();
const s = readState();
s.status = s.status || {};
s.signals = s.signals || [];
s.quotes = s.quotes || {};
s.watch = s.watch || [];
const log = [];
const docId = (x) => x.replace(/[^A-Za-z0-9_-]/g, "_");
const H20 = 20 * 3600e3;
const TAG_ICON = { chart_with_downwards_trend: "📉", chart_with_upwards_trend: "📈", bell: "🔔", mag: "🔎", sunrise: "🌅" };

// ---------- 1. Revolut X (solo lectura) ----------
function revx(args) {
  const opts = { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] };
  return process.platform === "win32" ? execSync(["revx", ...args].join(" "), opts) : execFileSync("revx", args, opts);
}
if (process.env.REVX_ENABLED !== "0") {
  try {
    const raw = JSON.parse(revx(["account", "balances", "--json"]));
    const list = Array.isArray(raw) ? raw : raw.balances || raw.data || [];
    const assets = list.map((b) => ({ asset: String(b.currency || b.asset || "").toUpperCase(), qty: Number(b.total ?? (Number(b.available || 0) + Number(b.reserved || 0))) }))
      .filter((b) => b.asset && b.qty > 0);
    for (const a of assets) {
      if (["EUR", "USD", "GBP"].includes(a.asset)) continue;
      try {
        const tx = JSON.parse(revx(["transaction", "list", "--currencies", a.asset, "--start-date", "1825d", "--limit", "500", "--json"]));
        const rows = (tx.data || []).filter((t) => t.status === "completed").sort((x, y) => x.created_date - y.created_date);
        let qty = 0, cost = 0;
        for (const t of rows) {
          if (t.type === "buy" && t.destination?.currency === a.asset && t.source?.currency === "EUR") { qty += Number(t.destination.amount); cost += Number(t.source.amount); }
          else if (t.type === "sell" && t.source?.currency === a.asset && qty > 0) { const q = Math.min(qty, Number(t.source.amount)); cost -= cost * (q / qty); qty -= q; }
        }
        if (qty > 0 && cost > 0) { a.costEur = Math.round(cost * 100) / 100; a.avgEur = Math.round((cost / qty) * 100) / 100; }
      } catch { /* sin historial */ }
    }
    s.crypto = { configured: true, at, assets };
    log.push(`Revolut X: ${assets.map((a) => a.asset).join(", ") || "sin saldo"}`);
  } catch (e) {
    // Si falla, se conserva el último saldo conocido
    log.push("Revolut X no respondió; uso el último saldo conocido");
    if (s.crypto) s.crypto.lastError = String(e.stderr || e.message).slice(0, 200);
  }
}

// ---------- 1b. Órdenes del móvil (vigilar / quitar), cifradas, por el canal ntfy «<topic>-cmd» ----------
if (cfg.ntfyTopic) {
  try {
    const since = s.status.cmdSince || "12h";
    const r = await fetch(`${cfg.ntfyServer || "https://ntfy.sh"}/${cfg.ntfyTopic}-cmd/json?poll=1&since=${encodeURIComponent(since)}`);
    const msgs = r.ok ? (await r.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.event === "message") : [];
    let applied = 0;
    for (const m of msgs) {
      let c;
      try { c = decrypt(JSON.parse(m.message)); } catch { continue; } // sin la clave: se ignora
      // Avisos de la app: alta o baja de un dispositivo (suscripción Web Push)
      if (c.op === "push-sub" || c.op === "push-unsub") {
        s.push = s.push || { subs: [] };
        const ep = String(c.sub?.endpoint || c.endpoint || "");
        if (/^https:\/\//.test(ep)) {
          s.push.subs = s.push.subs.filter((x) => x.endpoint !== ep);
          if (c.op === "push-sub" && c.sub?.keys?.p256dh && c.sub?.keys?.auth) {
            s.push.subs.push({ endpoint: ep, keys: { p256dh: String(c.sub.keys.p256dh), auth: String(c.sub.keys.auth) }, dev: String(c.dev || "").slice(0, 60), at: c.at, welcome: true });
            s.push.subs = s.push.subs.slice(-6);
          }
          applied++;
        }
        if (!s.status.cmdAppliedAt || c.at > s.status.cmdAppliedAt) s.status.cmdAppliedAt = c.at;
        s.status.cmdSince = m.id;
        continue;
      }
      const sym = String(c.symbol || "").toUpperCase().replace(/[^A-Z0-9.^=-]/g, "").slice(0, 20);
      if (!sym || !c.at) continue;
      if (c.op === "watch" && !s.watch.some((w) => w.symbol === sym)) { s.watch.push({ symbol: sym, name: String(c.name || sym).slice(0, 80), addedAt: c.at, by: "usuario" }); applied++; }
      if (c.op === "unwatch" && s.watch.some((w) => w.symbol === sym)) { s.watch = s.watch.filter((w) => w.symbol !== sym); applied++; }
      if (!s.status.cmdAppliedAt || c.at > s.status.cmdAppliedAt) s.status.cmdAppliedAt = c.at;
      s.status.cmdSince = m.id;
    }
    if (msgs.length) log.push(`Órdenes del móvil: ${applied} aplicada(s) de ${msgs.length}`);
  } catch (e) { log.push("Órdenes del móvil: no se pudieron leer (" + e.message + ")"); }
}

// Bienvenida a cada dispositivo recién dado de alta: confirma que los avisos llegan
for (const sub of [...(s.push?.subs || [])].filter((x) => x.welcome)) {
  if (!cfg.vapidJwk) break;
  if (await pushTo(sub, "Avisos de Centinela activados", "A partir de ahora los avisos de su cartera llegan aquí, sin otras apps.", 3, "bell")) { delete sub.welcome; log.push("Avisos: dispositivo nuevo confirmado"); }
  else if ((sub.fails || 0) >= 3) delete sub.welcome;
}

// ---------- 2. Símbolos: cartera (prioridad 1) y vigilancia (prioridad 2) ----------
const tier1 = new Set();
for (const h of holdingsFromLedger(s.ledger?.rows || [])) tier1.add(h.quote);
for (const a of s.crypto?.assets || []) if (!["EUR", "USD", "GBP"].includes(a.asset)) tier1.add(`${a.asset}-EUR`);
for (const m of s.positions?.manual || []) tier1.add(m.symbol);
if (!tier1.size) { tier1.add("NVDA"); tier1.add("BTC-EUR"); }
const tier2 = new Set(s.watch.map((w) => w.symbol).filter((x) => !tier1.has(x)));

// ---------- 3. Precios e indicadores ----------
const symbols = [...tier1, ...tier2];
const fresh = await mapLimit(symbols, 4, (sym) => analyze(sym, { ext: true }));
const fx = { EUR: 1 };
for (const c of new Set(fresh.filter((q) => !q.error).map((q) => q.currency))) { try { fx[c] = await fxEurPer(c); } catch { fx[c] = null; } }
let ok = 0;
for (const q of fresh) {
  if (q.error || q.price == null) { log.push(`${q.symbol}: sin precio (${q.error || "vacío"})`); continue; }
  const prev = s.quotes[docId(q.symbol)];
  q.prevSma200Side = prev && prev.sma200 ? Math.sign(prev.price - prev.sma200) : null;
  s.quotes[docId(q.symbol)] = { ...q, eurPer: fx[q.currency] ?? null, priceEur: fx[q.currency] ? Math.round(q.price * fx[q.currency] * 100) / 100 : null, updatedAt: at };
  ok++;
}
// Salidas a bolsa en vigilancia: el primer precio que llega significa que ya cotiza
const listed = [];
for (const w of s.watch || []) {
  if (!(w.ipo || w.ipoPrice) || w.listedAt) continue;
  const q = s.quotes[docId(w.symbol)];
  if (q && q.updatedAt === at && q.price) { w.listedAt = at; listed.push({ w, q }); }
}

// ---------- 4. Señales por reglas (sin noticias; prudentes) ----------
const recent = (sym, action) => s.signals.some((x) => x.symbol === sym && x.action === action && now - new Date(x.at) < H20);
// Ya se avisó de este valor en las últimas 20 h (por el motor o por la IA)
const notifiedRecently = (sym) => s.signals.some((x) => x.symbol === sym && x.notified && now - new Date(x.at) < H20);
const pct = (v) => `${v > 0 ? "+" : ""}${(v * 100).toFixed(1).replace(".", ",")} %`;
const money = (v, cur) => new Intl.NumberFormat("es-ES", { style: "currency", currency: cur || "USD", maximumFractionDigits: v >= 1000 ? 0 : 2 }).format(v);
const newSignals = [];
for (const sym of symbols) {
  const q = s.quotes[docId(sym)];
  if (!q || q.updatedAt !== at) continue;
  const tier = tier1.has(sym) ? 1 : 2;
  const name = sym.replace(/-EUR$/, "");
  const side = q.sma200 ? Math.sign(q.price - q.sma200) : null;
  const facts = `${money(q.price, q.currency)}, RSI ${q.rsi14?.toFixed(0)}, ${pct(q.drawdown)} desde máximos, media de 200 en ${money(q.sma200, q.currency)}.`;
  let sig = null;
  if (q.prevSma200Side === 1 && side === -1) sig = { code: "pierde_sma200", action: "vigilar", confidence: 55, title: `${name} pierde su media de 200 sesiones`, reason: `Ha cruzado a la baja su media de 200 sesiones: ${facts} Suele indicar que la tendencia de fondo se debilita.`, risk: "Sin análisis de noticias todavía: puede ser un ruido de un día." };
  else if (q.prevSma200Side === -1 && side === 1) sig = { code: "recupera_sma200", action: "vigilar", confidence: 55, title: `${name} recupera su media de 200 sesiones`, reason: `Vuelve por encima de su media de 200 sesiones: ${facts} Puede marcar el fin de la fase bajista.`, risk: "Los cruces sin volumen a menudo se deshacen." };
  else if ((q.change1d ?? 0) <= -0.05) sig = { code: "caida_dia", action: "vigilar", confidence: 50, title: `${name} cae ${pct(q.change1d)} en el día`, reason: `Caída fuerte en una sesión: ${facts}`, risk: "Sin noticias analizadas aún: conviene esperar a conocer el motivo." };
  else if ((q.change1d ?? 0) >= 0.06) sig = { code: "sube_dia", action: "mantener", confidence: 50, title: `${name} sube ${pct(q.change1d)} en el día`, reason: `Subida fuerte en una sesión: ${facts}`, risk: "Tras subidas bruscas son habituales las recogidas de beneficios." };
  else if (q.rsi14 != null && q.rsi14 < 30 && (q.drawdown ?? 0) <= -0.15) sig = { code: "sobreventa", action: "vigilar", confidence: 55, title: `${name} en sobreventa fuerte`, reason: `Sobreventa: ${facts} Técnicamente es zona de posible rebote.`, risk: "La sobreventa puede prolongarse si las noticias son malas." };
  else if (q.rsi14 != null && q.rsi14 > 75) sig = { code: "sobrecompra", action: "vigilar", confidence: 50, title: `${name} en sobrecompra`, reason: `Sobrecompra: ${facts}`, risk: "Riesgo de corrección a corto plazo." };
  if (!sig || recent(sym, sig.action) && !["pierde_sma200", "recupera_sma200", "caida_dia"].includes(sig.code)) continue;
  // Una misma sesión no genera dos señales de caída (la bolsa cerrada repite el dato de ayer)
  if (sig.code === "caida_dia" && (notifiedRecently(sym) || s.signals.some((x) => x.symbol === sym && x.code === "caida_dia" && x.marketTime === q.marketTime))) continue;
  sig.marketTime = q.marketTime;
  newSignals.push({ ...sig, at, symbol: sym, tier, sources: [], price: q.price, currency: q.currency, by: "motor", notified: false });
}

// ---------- 5. Avisos al móvil (máx. 3; nunca importes del usuario) ----------
async function pushTo(sub, title, message, priority, tags) {
  try {
    const r = await sendPush(sub, { title: `${TAG_ICON[tags] ? TAG_ICON[tags] + " " : ""}${title}`, body: message, tag: tags || "centinela", url: cfg.pwaUrl + "#senales" }, cfg.vapidJwk, { urgency: priority >= 4 ? "high" : "normal" });
    if (r.ok) { sub.lastOk = at; delete sub.fails; delete sub.lastErr; return true; }
    if (r.gone) { s.push.subs = s.push.subs.filter((x) => x !== sub); log.push(`Avisos: un dispositivo ya no admite avisos (${r.status}); se olvida`); return false; }
    sub.fails = (sub.fails || 0) + 1; sub.lastErr = `${r.status} ${r.text}`.slice(0, 160);
    log.push(`Avisos: error ${r.status} ${r.text}`.slice(0, 200));
  } catch (e) { sub.fails = (sub.fails || 0) + 1; sub.lastErr = String(e.message || e).slice(0, 160); }
  return false;
}
// Avisos propios de la app (Web Push) a todos sus dispositivos; ntfy solo como respaldo si no llega ninguno
async function notify(title, message, priority, tags) {
  if (cfg.vapidJwk && s.push?.subs?.length) {
    let delivered = 0;
    for (const sub of [...s.push.subs]) if (await pushTo(sub, title, message, priority, tags)) delivered++;
    if (delivered) return true;
  }
  if (!cfg.ntfyTopic) return false;
  const headers = { Title: `=?UTF-8?B?${Buffer.from(title).toString("base64")}?=`, Priority: String(priority), Tags: tags, Actions: `view, Abrir en el navegador, ${cfg.pwaUrl}`, "Content-Type": "text/plain; charset=utf-8" };
  try { const r = await fetch(`${cfg.ntfyServer || "https://ntfy.sh"}/${cfg.ntfyTopic}`, { method: "POST", headers, body: message }); return r.ok; } catch { return false; }
}
for (const { w, q } of listed) {
  const name = (w.name || w.symbol).replace(/\s*\(.*\)$/, "");
  const title = `${name} (${w.symbol}) ya cotiza`;
  const reason = `Primer precio: ${money(q.price, q.currency)}` + (w.ipoPrice ? `, ${pct(q.price / w.ipoPrice - 1)} sobre el precio de salida de ${money(w.ipoPrice, q.currency)}` : "") + ". Los primeros días suelen ser muy volátiles.";
  const sg = { code: "empieza_cotizar", action: "vigilar", confidence: 50, title, reason, risk: "Sin historial todavía: los indicadores técnicos tardarán semanas en ser fiables.", at, symbol: w.symbol, tier: 2, sources: [], price: q.price, currency: q.currency, by: "motor" };
  sg.notified = await notify(title, reason, 4, "bell");
  newSignals.push(sg);
  log.push(`${w.symbol}: empieza a cotizar (${q.price})`);
}
let sent = 0;
for (const sg of newSignals) {
  const important = sg.tier === 1 && ["caida_dia", "pierde_sma200", "recupera_sma200", "sube_dia"].includes(sg.code);
  if (!important || sent >= 3) continue;
  const down = ["caida_dia", "pierde_sma200"].includes(sg.code);
  sg.notified = await notify(sg.title, sg.reason.slice(0, 150), Math.abs(s.quotes[docId(sg.symbol)]?.change1d ?? 0) >= 0.08 ? 4 : 3, down ? "chart_with_downwards_trend" : "chart_with_upwards_trend");
  if (sg.notified) sent++;
}
s.signals.push(...newSignals.map((x) => ({ id: `${at.replace(/\D/g, "").slice(0, 12)}-${docId(x.symbol)}`, ...x })));

// Orden de las ideas: primero «comprar», luego «vigilar», luego «evitar»; dentro, por confianza y puntuación
const ENTRY_RANK = { comprar: 0, vigilar: 1, evitar: 2 };
function rankItems(items) {
  return [...(items || [])].sort((a, b) =>
    (ENTRY_RANK[a.verdict] ?? 3) - (ENTRY_RANK[b.verdict] ?? 3) || (b.confidence ?? 0) - (a.confidence ?? 0) || (b.score ?? 0) - (a.score ?? 0));
}

// ---------- 6. Escáner técnico (solo en modo scan) ----------
// El escáner diario también se hace si toca y nadie lo hizo (por si GitHub se salta la hora programada)
// Toca si hoy (UTC) aún no hay escáner hecho a partir de las 07:00: así no se va desplazando día a día
const today7 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 7));
const scanDue = now >= today7 && (!s.status.scanAt || new Date(s.status.scanAt) < today7);
if (mode === "scan" || scanDue) {
  const rows = await mapLimit(UNIVERSE.map((u) => u[0]), 6, analyze);
  const country = Object.fromEntries(UNIVERSE);
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const scored = [];
  for (const q of rows) {
    if (!q || q.error || q.price == null || tier1.has(q.symbol)) continue;
    const reasons = []; let sc = 50;
    if (q.sma200 && q.price > q.sma200) { sc += 10; reasons.push("por encima de su media de 200"); } else if (q.sma200) sc -= 10;
    if (q.sma50 && q.sma200 && q.sma50 > q.sma200) { sc += 6; reasons.push("medias en tendencia alcista"); }
    if (q.change90d != null) { sc += clamp(q.change90d * 60, -15, 15); if (q.change90d > 0.15) reasons.push(`+${(q.change90d * 100).toFixed(0)} % en 3 meses`); }
    if (q.drawdown != null && q.drawdown <= -0.08 && q.drawdown >= -0.3 && q.sma200 && q.price > q.sma200 * 0.97) { sc += 10; reasons.push(`retrocede ${(q.drawdown * -100).toFixed(0)} % desde máximos con la tendencia intacta`); }
    if (q.drawdown != null && q.drawdown < -0.45) sc -= 8;
    if (q.rsi14 != null) {
      if (q.rsi14 < 35 && q.sma200 && q.price > q.sma200 * 0.95) { sc += 8; reasons.push(`RSI ${q.rsi14.toFixed(0)} (sobreventa)`); }
      if (q.rsi14 > 75) { sc -= 8; reasons.push(`RSI ${q.rsi14.toFixed(0)} (sobrecompra)`); }
    }
    if (q.volumeRatio && q.volumeRatio > 1.8 && (q.change1d ?? 0) > 0) { sc += 5; reasons.push("entrada de volumen"); }
    if (q.vol30 && q.vol30 > 1.2) sc -= 6;
    const { history, triggers, ...rest } = q;
    scored.push({ ...rest, country: country[q.symbol] || "", score: Math.round(clamp(sc, 0, 100)), reason: reasons.join("; "), spark: history.slice(-90).map((h) => h[1]) });
  }
  scored.sort((a, b) => b.score - a.score);
  // Conserva el análisis con IA de la capa 2 si tiene menos de 36 h
  const aiTime = (i) => i.aiAt || s.scan?.enrichedAt;
  const prev = new Map((s.scan?.items || []).filter((i) => i.verdict && aiTime(i) && now - new Date(aiTime(i)) < 36 * 3600e3).map((i) => [i.symbol, { ...i, aiAt: aiTime(i) }]));
  const items = scored.slice(0, 25).map((it) => {
    const p = prev.get(it.symbol);
    return p ? { ...it, verdict: p.verdict, confidence: p.confidence, news: p.news, risk: p.risk, watchFor: p.watchFor, aiReason: p.aiReason || p.reason, reason: p.aiReason || p.reason, aiAt: p.aiAt, score: p.aiScore ?? it.score } : it;
  });
  const enriched = rankItems(items.filter((i) => i.verdict));
  s.scan = { at, analyzed: scored.length, enrichedAt: s.scan?.enrichedAt, items: [...enriched, ...items.filter((i) => !i.verdict)].slice(0, 15) };
  s.status.scanAt = at;
  log.push(`Escáner: ${scored.length} valores, ${enriched.length} con análisis de IA vigente`);
}

// ---------- 6b. Régimen del mercado cripto (skill crypto-regime-analyzer; lo deja regime.yml) ----------
const regimeFile = join(ROOT, "ai", "crypto-regime.json");
if (existsSync(regimeFile)) {
  try {
    const r = JSON.parse(readFileSync(regimeFile, "utf8"));
    if (r.at && r.score != null && (!s.cryptoRegime || r.at !== s.cryptoRegime.at)) { s.cryptoRegime = r; log.push(`Régimen cripto: ${r.zone} ${r.score}/100`); }
  } catch (e) { log.push("Régimen cripto no válido (" + e.message + ")"); }
}

// ---------- 6c. Noticias reales (cada hora) y métricas de valoración (una vez al día) ----------
const newsSyms = [...new Set([...symbols, ...(s.scan?.items || []).slice(0, 10).map((i) => i.symbol)])];
const nameOf = (sym) => s.quotes[docId(sym)]?.name || (s.scan?.items || []).find((i) => i.symbol === sym)?.name || s.watch.find((w) => w.symbol === sym)?.name || sym;
try {
  const r = await refreshNews(s, newsSyms.map((sym) => ({ sym, name: nameOf(sym) })), mapLimit, now);
  log.push(`Noticias: ${r.total} titulares (${r.fresh} nuevos${r.errors ? `, ${r.errors} búsquedas fallidas` : ""})`);
} catch (e) { log.push("Noticias: " + e.message); }
try {
  const r = await refreshFundamentals(s, newsSyms, s.finnhubKey || process.env.FINNHUB_KEY, now);
  if (r.done) log.push(`Valoración: ${r.done} valores actualizados`);
} catch (e) { log.push("Valoración: " + e.message); }

// ---------- 7. Capa 2 (IA): integra ai/notes.json si es más nuevo que lo último integrado ----------
// La rutina de Claude solo ve datos públicos de mercado y deja aquí su análisis de noticias.
const notesFile = join(ROOT, "ai", "notes.json");
if (existsSync(notesFile)) {
  try {
    const nn = JSON.parse(readFileSync(notesFile, "utf8"));
    // Si la IA pone una hora futura, se toma la de ahora (la app nunca muestra «dentro de…»)
    if (nn.at && new Date(nn.at) > now) nn.at = now.toISOString();
    const nAt = nn.at && new Date(nn.at);
    if (nAt && !isNaN(nAt) && (!s.status.aiMergedAt || nAt > new Date(s.status.aiMergedAt))) {
      let merged = 0, aiSent = 0;
      // Texto de la IA: siempre cadena, recortada (nunca HTML ni objetos)
      const tx = (x, n = 300) => (x == null ? undefined : String(x).replace(/\s+/g, " ").trim().slice(0, n) || undefined);
      const cats = (a) => (Array.isArray(a) ? a : []).slice(0, 5).map((c) => ({ d: tx(c?.d, 20), e: tx(c?.e, 120), imp: tx(c?.imp, 10) })).filter((c) => c.e);
      s.analysis = s.analysis || {};
      // Panorama del día: noticias que mueven el mercado, escenarios y lectura cripto
      const mk = nn.market || {};
      if (mk.summary || (mk.events || []).length) {
        s.market = {
          at: nn.at, regime: tx(mk.regime, 20), summary: tx(mk.summary, 700),
          events: (mk.events || []).slice(0, 6).map((e) => ({ t: tx(e?.t, 140), impact: tx(e?.impact, 10), affects: tx(e?.affects, 140), u: /^https:\/\//.test(e?.u || "") ? e.u : undefined })).filter((e) => e.t),
          scenarios: (mk.scenarios || []).slice(0, 3).map((e) => ({ name: tx(e?.name, 60), prob: Math.max(0, Math.min(100, Number(e?.prob) || 0)), effect: tx(e?.effect, 200) })).filter((e) => e.name),
          catalysts: cats(mk.catalysts),
          crypto: tx(nn.crypto?.summary || mk.crypto, 400),
          // Salidas a bolsa próximas o recientes y si se puede invertir desde Revolut
          ipos: (mk.ipos || []).slice(0, 8).map((e) => ({ name: tx(e?.name, 60), ticker: tx(e?.ticker, 12), d: tx(e?.d, 20), market: tx(e?.market, 30), revolut: ["sí", "no", "desconocido"].includes(e?.revolut) ? e.revolut : "desconocido", note: tx(e?.note, 220), u: /^https:\/\//.test(e?.u || "") ? e.u : undefined })).filter((e) => e.name),
        };
      }
      const VERDICTS = ["comprar", "reforzar", "mantener", "reducir", "vender", "vigilar"];
      for (const [sym, n] of Object.entries(nn.notes || {})) {
        if (!VERDICTS.includes(n.verdict)) continue;
        const conf = Math.max(0, Math.min(100, Number(n.confidence) || 0));
        const sources = (n.sources || []).filter((x) => /^https:\/\//.test(x?.u || "")).slice(0, 4).map((x) => ({ t: String(x.t || "Fuente").slice(0, 140), u: x.u }));
        // Candidatas del escáner
        // Para quien NO la tiene: comprar | vigilar | evitar (si la IA no lo da, se deduce del veredicto)
        const ENTRY = { comprar: "comprar", reforzar: "comprar", vigilar: "vigilar", mantener: "vigilar", reducir: "evitar", vender: "evitar" };
        const entry = ["comprar", "vigilar", "evitar"].includes(n.entry) ? n.entry : ENTRY[n.verdict];
        const entryConf = Math.max(0, Math.min(100, Number(n.entryConfidence ?? n.confidence) || 0));
        // Tesis (por qué invertir), qué la rompería, valoración y próximas fechas clave
        s.analysis[sym] = { at: nn.at, thesis: tx(n.thesis, 400), breaks: tx(n.breaks, 250), valuation: tx(n.valuation, 250), catalysts: cats(n.catalysts) };
        const it = (s.scan?.items || []).find((i) => i.symbol === sym);
        if (it) Object.assign(it, { verdict: entry, confidence: entryConf, news: n.news, risk: n.risk, watchFor: n.watchFor, aiReason: n.reason, reason: n.reason || it.reason, aiAt: nn.at });
        // Cartera y vigilancia: señal con noticias
        if (tier1.has(sym) || tier2.has(sym)) {
          const tier = tier1.has(sym) ? 1 : 2;
          if (tier === 2 && !["comprar", "vigilar"].includes(n.verdict)) { merged++; continue; }
          // Mismo veredicto en las últimas 20 h: se actualiza esa señal con las noticias nuevas en vez de duplicarla
          const prevSig = s.signals.find((x) => x.symbol === sym && x.action === n.verdict && x.by === "ia" && now - new Date(x.at) < H20);
          if (prevSig && conf < 70) {
            const q = s.quotes[docId(sym)] || {};
            Object.assign(prevSig, { at, confidence: conf, title: String(n.title || prevSig.title).slice(0, 60), reason: n.reason, risk: n.risk, sources: sources.length ? sources : prevSig.sources, price: q.price ?? prevSig.price, updates: (prevSig.updates || 0) + 1 });
          } else if (!recent(sym, n.verdict) || conf >= 70) {
            const q = s.quotes[docId(sym)] || {};
            const sg = { id: `${at.replace(/\D/g, "").slice(0, 12)}-${docId(sym)}-ia`, at, symbol: sym, tier, action: n.verdict, confidence: conf, title: String(n.title || `${sym}: ${n.verdict}`).slice(0, 60), reason: n.reason, risk: n.risk, sources, price: q.price, currency: q.currency, by: "ia", notified: false };
            if (conf >= 70 && n.verdict !== "mantener" && aiSent < 3 && !notifiedRecently(sym)) {
              sg.notified = await notify(`${sym.replace(/-EUR$/, "")}: ${n.verdict[0].toUpperCase() + n.verdict.slice(1)}`, String(n.reason || "").slice(0, 150), conf >= 80 ? 4 : 3, ["reducir", "vender"].includes(n.verdict) ? "chart_with_downwards_trend" : "chart_with_upwards_trend");
              if (sg.notified) aiSent++;
            }
            s.signals.push(sg);
          }
        }
        // Oportunidad fuerte: pasa a vigilancia
        if (!tier1.has(sym) && entry === "comprar" && entryConf >= 75 && !s.watch.some((w) => w.symbol === sym)) {
          s.watch.push({ symbol: sym, name: it?.name || sym, addedAt: at, by: "IA" });
          if (aiSent < 3 && await notify(`Oportunidad: ${sym}`, String(n.reason || "").slice(0, 150), 3, "mag")) aiSent++;
        }
        merged++;
      }
      s.status.aiAt = nn.at; s.status.aiMergedAt = nn.at;
      if (s.scan) { s.scan.enrichedAt = nn.at; s.scan.items = rankItems(s.scan.items); }
      log.push(`IA: ${merged} análisis integrados, ${aiSent} aviso(s)`);
    }
  } catch (e) { log.push("IA: ai/notes.json no válido (" + e.message + ")"); }
}

// Petición para la capa 2: solo datos públicos de mercado, sin cantidades ni marcar qué es del usuario
{
  const pick = new Set([...symbols, ...(s.scan?.items || []).slice(0, 10).map((i) => i.symbol)]);
  const list = [...pick].sort().map((sym) => {
    const q = s.quotes[docId(sym)] || (s.scan?.items || []).find((i) => i.symbol === sym) || {};
    return { symbol: sym, name: q.name, kind: q.kind, price: q.price, currency: q.currency, change1d: q.change1d, change30d: q.change30d, rsi14: q.rsi14, drawdown: q.drawdown, sma50: q.sma50, sma200: q.sma200, phase: q.phaseLabel, technicalScore: (s.scan?.items || []).find((i) => i.symbol === sym)?.score ?? null };
  });
  mkdirSync(join(ROOT, "docs"), { recursive: true });
  const cr = s.cryptoRegime ? { at: s.cryptoRegime.at, score: s.cryptoRegime.score, zone: s.cryptoRegime.zone, guidance: s.cryptoRegime.guidance, components: s.cryptoRegime.components } : null;
  // Tesis del día anterior para que la IA las actualice en vez de reescribirlas de cero
  const prevThesis = Object.fromEntries([...pick].filter((x) => s.analysis?.[x]?.thesis).map((x) => [x, { thesis: s.analysis[x].thesis, breaks: s.analysis[x].breaks }]));
  // Titulares reales de las últimas horas (Google Noticias) y métricas de valoración (Finnhub)
  const NI = s.news?.items || [];
  const brief = (x) => ({ t: x.t, src: x.src, at: x.at, u: x.u });
  const news = Object.fromEntries([...pick].map((x) => [x, NI.filter((n) => n.syms.includes(x)).slice(0, 8).map(brief)]).filter(([, v]) => v.length));
  const marketNews = NI.filter((n) => n.cats.some((c) => c !== "valor")).slice(0, 30).map((x) => ({ ...brief(x), cats: x.cats }));
  const fundamentals = Object.fromEntries([...pick].filter((x) => s.fund?.[x]).map((x) => [x, s.fund[x]]));
  writeFileSync(join(ROOT, "docs", "ai-request.json"), JSON.stringify({ at, symbols: list, cryptoRegime: cr, prevThesis, news, marketNews, fundamentals }, null, 1));
}

// ---------- 7b. Resumen matinal (una vez al día, entre las 07:00 y las 11:00 de Dublín) ----------
// Solo porcentajes: nunca importes ni cantidades del usuario.
{
  const dub = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Dublin", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }).formatToParts(now);
  const P = Object.fromEntries(dub.map((x) => [x.type, x.value]));
  const today = `${P.year}-${P.month}-${P.day}`, hour = Number(P.hour) % 24;
  if ((process.env.FORCE_SUMMARY === "1" || (hour >= 7 && hour < 11)) && s.status.summaryDate !== today) {
    const pc = (v) => v == null || !isFinite(v) ? "—" : `${v > 0 ? "+" : ""}${(v * 100).toFixed(1).replace(".", ",")} %`;
    const H = holdingsFromLedger(s.ledger?.rows || []).map((h) => ({ sym: h.quote, qty: h.qty }))
      .concat((s.crypto?.assets || []).filter((a) => !["EUR", "USD", "GBP"].includes(a.asset)).map((a) => ({ sym: `${a.asset}-EUR`, qty: a.qty })))
      .concat((s.positions?.manual || []).map((m) => ({ sym: m.symbol, qty: m.qty })));
    const seen = new Set(); const hold = H.filter((h) => !seen.has(h.sym) && seen.add(h.sym));
    let val = 0, prev = 0;
    const parts = [];
    for (const h of hold) {
      const q = s.quotes[docId(h.sym)]; if (!q?.priceEur) continue;
      const v = h.qty * q.priceEur; val += v; prev += v / (1 + (q.change1d || 0));
      parts.push(`${h.sym.replace(/-EUR$/, "")} ${pc(q.change1d)}`);
    }
    const tot = prev ? val / prev - 1 : null;
    const idx = await mapLimit([["ES=F", "S&P 500 (fut.)"], ["NQ=F", "Nasdaq (fut.)"], ["^N225", "Nikkei"], ["^GDAXI", "DAX"]], 4, async ([sym, name]) => { try { const q = await analyze(sym); return `${name} ${pc(q.change1d)}`; } catch { return null; } });
    // Wall Street hoy
    const ny = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).map((x) => [x.type, x.value]));
    const US_OFF = ["2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24"];
    const nyDate = `${ny.year}-${ny.month}-${ny.day}`;
    const wall = ["Sat", "Sun"].includes(ny.weekday) || US_OFF.includes(nyDate) ? "Wall Street cerrada hoy." : "Wall Street abre a las 14:30 (hora de Dublín).";
    // Veredictos de la IA sobre su cartera y la mejor idea
    const mine = hold.map((h) => s.signals.find((x) => x.symbol === h.sym)).filter(Boolean).map((x) => `${x.symbol.replace(/-EUR$/, "")} ${x.action} ${x.confidence} %`);
    const ideas = (s.scan?.items || []).filter((i) => !seen.has(i.symbol)); // nunca lo que ya tiene
    const best = ideas.find((i) => i.verdict === "comprar") || ideas.find((i) => i.verdict === "vigilar");
    const body = [
      `Cartera ${pc(tot)} en 24 h${parts.length ? ` (${parts.join(", ")})` : ""}.`,
      idx.filter(Boolean).length ? `Noche: ${idx.filter(Boolean).join(" · ")}.` : "",
      wall,
      mine.length ? `Señales: ${mine.join(" · ")}.` : "",
      best ? `Idea del día: ${best.symbol} (${best.verdict} ${best.confidence} %).` : "",
      s.status.aiAt && now - new Date(s.status.aiAt) < 30 * 3600e3 ? "" : "Análisis de noticias en pausa: solo datos estadísticos.",
    ].filter(Boolean).join("\n");
    const okSent = await notify(`Buenos días · cartera ${pc(tot)}`, body, 3, "sunrise");
    if (okSent) { s.status.summaryDate = today; log.push("Resumen matinal enviado"); }
    else log.push("Resumen matinal: no se pudo enviar");
    if (process.env.FORCE_SUMMARY === "1") console.log("RESUMEN:\n" + body);
  }
}

// ---------- 8. Estado ----------
// Clave pública de los avisos de la app (la privada solo vive en los secretos de GitHub)
if (cfg.vapidJwk) { s.push = s.push || { subs: [] }; s.push.key = vapidPublic(cfg.vapidJwk); }
s.status.portfolioAt = at;
s.status.engine = "github";
const aiFresh = s.status.aiAt && now - new Date(s.status.aiAt) < 30 * 3600e3;
s.status.note = `Revisión automática: ${ok}/${symbols.length} precios, ${newSignals.length} señal(es) nueva(s) por reglas, ${sent} aviso(s).` +
  (aiFresh ? "" : " Análisis de noticias con IA en pausa: las señales son solo estadísticas.");
writeState(s);
console.log([`Modo ${mode}`, ...log, s.status.note].join("\n"));
if (!ok) process.exit(3); // ningún precio: algo va mal con Yahoo; no se publica
