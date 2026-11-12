// ---------- modo app del móvil (inyectado por engine/pwa.mjs) ----------
// Sustituye la BD de claude.ai por data.enc.json, cifrado con AES-256-GCM.
// La clave se escribe una vez y se guarda solo en este dispositivo.
const KEY_LS = "centinela.key";
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };
const normKey = (k) => String(k || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
let pwaDash = null, pwaLoading = false, pwaLastAt = null;

const pwaStyle = document.createElement("style");
pwaStyle.textContent = `
#import,#manual{display:none!important}
.lock{position:fixed;inset:0;z-index:50;background:var(--bg);display:grid;place-items:center;padding:24px}
.lock .card{width:min(380px,100%);background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:28px 22px;display:grid;gap:14px;text-align:center}
.lock .eye{width:18px;height:18px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 7px var(--accent-soft);justify-self:center;margin-bottom:6px}
.lock h2{font-family:var(--f-display);margin:0;font-size:24px}
.lock input{font:500 18px var(--f-mono);letter-spacing:.06em;text-transform:uppercase;text-align:center;padding:12px;border-radius:10px;border:1px solid var(--line);background:var(--sunk);color:var(--fg);width:100%}
.lock .err{color:var(--loss);font-size:14px;min-height:1.2em}
.ptoast{position:fixed;left:50%;bottom:calc(18px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:40;background:var(--fg);color:var(--bg);padding:10px 16px;border-radius:10px;font-size:14px;max-width:calc(100% - 32px);box-shadow:0 6px 24px rgba(0,0,0,.2)}
#fresh{cursor:pointer}
`;
document.head.appendChild(pwaStyle);

toast = (text, err = false) => {
  document.querySelectorAll(".ptoast").forEach((n) => n.remove());
  const n = el("div", { class: "ptoast", text, role: "status" });
  if (err) n.style.background = "var(--loss)";
  document.body.appendChild(n);
  setTimeout(() => n.remove(), 4200);
};

// ---- piel de app: barra inferior, héroe, tarjetas ----
const ICONS = {
  cartera: ["Inicio", '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>'],
  senales: ["Señales", '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>'],
  oportunidades: ["Ideas", '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>'],
  proyeccion: ["Futuro", '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>'],
  ajustes: ["Ajustes", '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>'],
};
const svgIcon = (inner) => { const t = document.createElement("template"); t.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`; return t.content.firstChild; };
(function skin() {
  const eye = $(".brand .eye");
  if (eye) eye.replaceWith(el("img", { class: "logo", src: "icons/icon-192.png", alt: "" }));
  const nav = $("nav.tabs");
  nav.querySelectorAll("a").forEach((a) => { const [label, ic] = ICONS[a.dataset.view] || [a.textContent, ""]; a.replaceChildren(svgIcon(ic), el("span", { text: label })); });
  document.body.appendChild(nav);
  const h = new Date().getHours();
  const hi = h >= 6 && h < 13 ? "Buenos días" : h >= 13 && h < 21 ? "Buenas tardes" : "Buenas noches";
  $("#summary").prepend(el("div", { class: "hello" }, el("div", { class: "kick" }, el("i"), "Centinela · Su cartera"), el("h2", { text: hi + ", Fran" })));
  const quick = el("div", { class: "quick" },
    el("a", { class: "primary", href: "#senales" }, svgIcon(ICONS.senales[1]), "Ver señales"),
    el("a", { href: "#proyeccion" }, svgIcon(ICONS.proyeccion[1]), "Proyección"));
  $("#summary").after(quick);
  quick.after($("#positions"));
  const pnlLabel = $("#k-pnl")?.previousElementSibling; if (pnlLabel) pnlLabel.textContent = "Resultado";
  $("#last-signals h2").append(el("a", { class: "more", href: "#senales", text: "Ver todas" }));
  $("#positions h2").append(el("a", { class: "more", href: "#oportunidades", text: "Ideas" }));
})();
const AV = ["#F0B354", "#4FD195", "#7FB2F0", "#C79BEA", "#FF9C8A", "#6FD6D6"];
const avColor = (s) => AV[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % AV.length];
let pwaLogos = {};
// Logo real si lo hay (viene dentro de los datos cifrados); si no, iniciales de color
const avatar = (sym, cls = "av") => {
  const src = pwaLogos[sym] || pwaLogos[sym + "-EUR"] || pwaLogos[sym + "-USD"];
  if (src) return el("div", { class: cls + " has-logo" }, el("img", { src, alt: "", loading: "lazy" }));
  return el("div", { class: cls, style: `background:${avColor(sym)}`, text: sym.replace(/-(EUR|USD)$/, "").slice(0, 4) });
};
const _renderOpportunities = renderOpportunities;
renderOpportunities = () => {
  _renderOpportunities();
  document.querySelectorAll("#scan-list .opp .hd").forEach((hd) => {
    const b = hd.querySelector("b"); if (!b) return;
    hd.prepend(avatar(b.textContent, "av sm"));
  });
};
const _renderPortfolio = renderPortfolio;
renderPortfolio = () => {
  _renderPortfolio();
  // columnas: Activo, Cantidad, Precio medio, Precio, Hoy, Valor, Resultado, 90 días, Señal
  const CLS = ["c-name", "c-qty", "c-avg", "c-price", "c-today", "c-val", "c-res", "c-spark", "c-sig"];
  document.querySelectorAll("table.pos tbody tr").forEach((tr) => {
    const tds = [...tr.children];
    tds.forEach((td, i) => td.classList.add(CLS[i]));
    const sym = tds[0].querySelector(".tk")?.textContent || "?";
    const [qty, avg, price, today] = [tds[1], tds[2], tds[3], tds[4]].map((t) => t.textContent);
    tds[3].textContent = price;
    tds[1].classList.replace("c-qty", "c-meta");
    tds[1].replaceChildren(`${qty} uds · medio ${avg} · hoy `, el("span", { class: tds[4].className.replace(/num|c-today/g, "").trim(), text: today }));
    // Fuera de horario el precio es el de preapertura/cierre ampliado (como Revolut); se indica el cierre oficial
    const hq = allHoldings().find((h) => h.symbol === sym || h.quote === sym)?.q;
    if (hq?.regularPrice != null && hq.extSession) tds[1].append(` · ${hq.extSession === "pre" ? "precio de preapertura" : "precio de cierre ampliado"}, cierre ${fmtMoney(hq.regularPrice, hq.currency)}`);
    tds[2].classList.add("c-hide"); tds[4].classList.add("c-hide");
    tds[7].querySelector("svg")?.setAttribute("preserveAspectRatio", "none");
    tr.prepend(el("td", { class: "c-av" }, avatar(sym)));
  });
  if (typeof renderMarkets === "function" && S.loaded) renderMarkets();
};
const _signalNode = signalNode;
signalNode = (s, compact) => {
  const n = _signalNode(s, compact); n.dataset.a = s.action || "";
  const t = n.querySelector(".tick"), src = pwaLogos[s.symbol];
  if (t && src) { t.classList.add("has-logo"); t.replaceChildren(el("img", { src, alt: s.symbol })); }
  return n;
};
// ---- precios en directo mientras la app está abierta ----
// Cripto: Binance (público, sin clave). Acciones: Finnhub, con la clave gratuita que el usuario
// guarda solo en este móvil. Los proveedores ven qué valores se consultan, nunca cuántos tiene.
const FH_LS = "centinela.finnhub";
let liveAt = 0, liveTimer = null, pwaFinnhub = null;
async function liveTick() {
  if (document.visibilityState !== "visible" || !S.loaded) return;
  // Clave de Finnhub: la del móvil si el usuario puso una; si no, la que viaja cifrada en sus datos
  const fh = lsGet(FH_LS) || pwaFinnhub;
  let changed = 0;
  await Promise.all(allHoldings().map(async (h) => {
    const q = h.q; if (!q) return;
    try {
      if (q.kind === "crypto") {
        const r = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${encodeURIComponent(h.quote.replace(/-/g, ""))}`);
        if (!r.ok) return;
        const j = await r.json(), p = Number(j.lastPrice);
        if (!p) return;
        q.price = p; q.priceEur = q.currency === "EUR" ? p : p * (q.eurPer || 1); q.change1d = Number(j.priceChangePercent) / 100; changed++;
      } else if (fh) {
        const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(h.quote)}&token=${encodeURIComponent(fh)}`);
        if (!r.ok) return;
        const j = await r.json();
        if (!j.c) return;
        // Fuera de horario Finnhub solo da el cierre: no pisa el precio de preapertura/cierre ampliado del motor
        if (q.extAt && (!j.t || j.t * 1000 < new Date(q.extAt).getTime())) return;
        q.price = j.c; q.priceEur = Math.round(j.c * (q.eurPer || 1) * 100) / 100; q.change1d = (j.dp ?? 0) / 100;
        q.liveClosed = j.t && Date.now() / 1000 - j.t > 20 * 60; changed++;
      }
    } catch { /* sin conexión: se mantiene el último precio */ }
  }));
  if (changed) { liveAt = Date.now(); renderPortfolio(); renderFresh(); }
}
function startLive() {
  if (liveTimer) return;
  liveTick();
  liveTimer = setInterval(liveTick, 15000);
}
const _renderFresh = renderFresh;
renderFresh = () => {
  _renderFresh();
  const f = $("#fresh"), at = S.status?.portfolioAt;
  const live = Date.now() - liveAt < 60000;
  f.classList.toggle("live", live);
  f.classList.toggle("stale", !live && (!at || Date.now() - new Date(at).getTime() > 3 * 3600e3));
  if (live) f.replaceChildren(el("b", { text: "En directo" }));
};

// ---- estado de los mercados (abierto, preapertura, cierre ampliado, cerrado) ----
// Horarios oficiales en la hora local de cada bolsa; festivos completos y medias sesiones de NYSE/Nasdaq.
const US_HOLIDAYS = new Set(["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24"]);
const US_HALF = new Set(["2026-11-27", "2026-12-24", "2027-11-26"]);
const MARKETS = {
  us: { name: "Wall Street", flag: "🇺🇸", tz: "America/New_York", pre: 240, open: 570, close: 960, post: 1200, holidays: US_HOLIDAYS, half: US_HALF },
  de: { name: "Fráncfort", flag: "🇩🇪", tz: "Europe/Berlin", open: 540, close: 1050 },
  uk: { name: "Londres", flag: "🇬🇧", tz: "Europe/London", open: 480, close: 990 },
  eu: { name: "Euronext", flag: "🇪🇺", tz: "Europe/Paris", open: 540, close: 1050 },
  jp: { name: "Tokio", flag: "🇯🇵", tz: "Asia/Tokyo", open: 540, close: 930 },
  crypto: { name: "Cripto", flag: "₿", always: true },
};
function localParts(tz, d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false }).formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, mins: (Number(p.hour) % 24) * 60 + Number(p.minute), wd: p.weekday };
}
const dur = (m) => m >= 1440 ? `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h` : m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
function marketStatus(key, now = new Date()) {
  const M = MARKETS[key];
  if (!M) return null;
  if (M.always) return { key, ...M, state: "abierto", label: "Abierto 24/7", detail: "" };
  const isTradingDay = (d) => { const lp = localParts(M.tz, d); return !["Sat", "Sun"].includes(lp.wd) && !(M.holidays && M.holidays.has(lp.date)); };
  const lp = localParts(M.tz, now);
  const close = M.half && M.half.has(lp.date) ? 780 : M.close;
  const trading = isTradingDay(now);
  // Minutos hasta la próxima apertura (busca el siguiente día hábil)
  const nextOpen = () => {
    if (trading && lp.mins < (M.pre ?? M.open)) return (M.pre ?? M.open) - lp.mins;
    for (let k = 1; k <= 7; k++) { const d = new Date(now.getTime() + k * 864e5); if (isTradingDay(d)) return k * 1440 - lp.mins + (M.pre ?? M.open); }
    return null;
  };
  if (trading && lp.mins >= M.open && lp.mins < close) return { key, ...M, state: "abierto", label: "Abierta", detail: `cierra en ${dur(close - lp.mins)}` };
  if (trading && M.pre != null && lp.mins >= M.pre && lp.mins < M.open) return { key, ...M, state: "pre", label: "Preapertura", detail: `abre en ${dur(M.open - lp.mins)}` };
  if (trading && M.post != null && lp.mins >= close && lp.mins < (M.half && M.half.has(lp.date) ? 1020 : M.post)) return { key, ...M, state: "post", label: "Cierre ampliado", detail: "after-hours" };
  const n = nextOpen();
  const why = !trading && M.holidays && M.holidays.has(lp.date) ? "festivo · " : ["Sat", "Sun"].includes(lp.wd) ? "fin de semana · " : "";
  return { key, ...M, state: "cerrado", label: "Cerrada", detail: why + (n != null ? `${M.pre != null ? "preapertura" : "abre"} en ${dur(n)}` : "") };
}
// Bolsa de cada valor: por su mercado de cotización (los ADR cotizan en EE. UU.)
function marketOf(q) {
  if (!q) return null;
  if (q.kind === "crypto") return "crypto";
  const ex = String(q.exchange || "").toLowerCase();
  if (/nasdaq|nyse|nms|nyq|nca|nasdaqgs|nasdaqgm|arca|bats|cboe/.test(ex) || q.currency === "USD") return "us";
  if (/xetra|frankfurt|ger/.test(ex)) return "de";
  if (/london|lse/.test(ex)) return "uk";
  if (/paris|amsterdam|euronext|madrid|milan/.test(ex)) return "eu";
  if (/tokyo|jpx/.test(ex)) return "jp";
  return null;
}
function marketBar() {
  const used = new Set(["us", "crypto", ...Object.values(S.quotes || {}).map(marketOf).filter(Boolean)]);
  return el("div", { class: "mkt-bar" }, [...used].map((k) => {
    const st = marketStatus(k);
    return el("div", { class: "mkt m-" + st.state }, el("span", { class: "dot" }), el("b", { text: `${st.flag} ${st.name}` }), el("span", { text: st.label }), st.detail ? el("small", { text: st.detail }) : "");
  }));
}
function renderMarkets() {
  for (const [host, id] of [["#v-cartera", "mkt-home"], ["#v-oportunidades", "mkt-ideas"]]) {
    const view = $(host); if (!view) continue;
    const old = document.getElementById(id);
    const bar = marketBar(); bar.id = id;
    if (old) old.replaceWith(bar); else view.prepend(bar);
  }
  // Etiqueta en cada posición
  document.querySelectorAll("table.pos tbody tr").forEach((tr) => {
    const sym = tr.querySelector(".tk")?.textContent; if (!sym) return;
    const h = allHoldings().find((x) => x.symbol === sym);
    const st = marketStatus(marketOf(h?.q));
    if (!st) return;
    tr.querySelector(".mk-tag")?.remove();
    tr.querySelector(".c-name")?.append(el("span", { class: "mk-tag m-" + st.state, text: st.state === "abierto" ? (st.always ? "24/7" : "mercado abierto") : st.label.toLowerCase() }));
  });
}
setInterval(() => { if (document.visibilityState === "visible" && S.loaded) renderMarkets(); }, 30000);

// ---- vigilancia desde el móvil ----
// La orden viaja cifrada con su clave (AES-GCM) por un canal ntfy privado; el motor de GitHub
// la recoge en su siguiente revisión horaria. Mientras, la app la muestra como «pendiente».
const PEND_LS = "centinela.pending";
let pwaTopic = null;
const pending = () => { try { return JSON.parse(lsGet(PEND_LS) || "[]"); } catch { return []; } };
async function encryptForEngine(obj) {
  const k = lsGet(KEY_LS); if (!k) throw new Error("sin clave");
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(k), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 210000 }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(obj))));
  const b = (u) => btoa(String.fromCharCode(...u));
  return { v: 1, iter: 210000, salt: b(salt), iv: b(iv), ct: b(ct) };
}
async function sendCmd(cmd) {
  if (!pwaTopic) throw new Error("sin canal");
  const r = await fetch(`https://ntfy.sh/${encodeURIComponent(pwaTopic + "-cmd")}`, { method: "POST", body: JSON.stringify(await encryptForEngine(cmd)) });
  if (!r.ok) throw new Error("ntfy " + r.status);
}
function applyPending() {
  const appliedAt = S.status?.cmdAppliedAt || "";
  const list = pending().filter((c) => c.at > appliedAt); // las ya aplicadas por el motor se olvidan
  lsSet(PEND_LS, JSON.stringify(list));
  for (const c of list) {
    if (c.op === "watch" && !S.watch.some((w) => w.symbol === c.symbol)) S.watch.push({ symbol: c.symbol, name: c.name, addedAt: c.at, by: "usuario", pending: true });
    if (c.op === "unwatch") S.watch = S.watch.filter((w) => w.symbol !== c.symbol);
  }
}
async function queueCmd(op, symbol, name) {
  const c = { op, symbol, name: name || "", at: new Date().toISOString() };
  try {
    await sendCmd(c);
    lsSet(PEND_LS, JSON.stringify([...pending(), c]));
    applyPending(); renderOpportunities();
    toast(op === "watch" ? `${symbol} en vigilancia. El vigilante lo incorpora en su próxima revisión (máx. 1 h).` : `${symbol} quitado de vigilancia.`);
  } catch (e) { toast("No se pudo enviar: " + (e.message || e), true); }
}
watch = (it) => queueCmd("watch", it.symbol, it.name);
unwatch = (w) => queueCmd("unwatch", w.symbol, w.name);
const _renderOpp2 = renderOpportunities;
const GROUPS = {
  comprar: ["Para invertir ahora", "Buen punto de entrada: el técnico, las noticias y la valoración acompañan."],
  vigilar: ["Para vigilar", "Interesantes, pero conviene esperar a un mejor precio o a una confirmación."],
  evitar: ["Descartadas por ahora", "No resultan atractivas en este momento."],
  none: ["Sin analizar todavía", "Solo puntuación técnica; la IA las revisará en su próximo análisis."],
};
renderOpportunities = () => {
  _renderOpp2();
  // Agrupa las candidatas del escáner según convenga invertir, vigilar o descartar
  const items = S.scan?.items || [];
  let last = null;
  document.querySelectorAll("#scan-list .opp").forEach((node, i) => {
    const it = items[i]; if (!it) return;
    const g = GROUPS[it.verdict] ? it.verdict : "none";
    if (g !== last) {
      node.before(el("div", { class: "opp-group g-" + g }, el("h3", { text: GROUPS[g][0] }), el("p", { class: "note", text: GROUPS[g][1] })));
      last = g;
    }
    if (it.verdict && it.confidence != null) node.querySelector(".hd .pill")?.after(el("span", { class: "flat num", style: "font-size:12.5px", text: `confianza ${it.confidence} %` }));
  });
  // Marca las que aún esperan al motor
  document.querySelectorAll("#watch-list .status-row").forEach((row) => {
    const sym = row.querySelector("b")?.textContent.trim();
    if (S.watch.find((w) => w.symbol === sym)?.pending) row.querySelector("span")?.append(el("span", { class: "pill p-watch", style: "margin-left:6px", text: "pendiente" }));
  });
};

// ---- aportación del mes: cómo repartir lo que va a invertir ----
// Todo se calcula en este móvil con los datos ya descifrados: la cantidad no sale de aquí.
const AP_LS = "centinela.aporte";
const VERD = { comprar: "comprar", reforzar: "comprar", mantener: "mantener", vigilar: "vigilar", reducir: "evitar", vender: "evitar", evitar: "evitar" };
const V_BASE = { comprar: 1, mantener: 0.6, vigilar: 0.35, evitar: 0 };
const PH_MULT = { correccion: 1.15, alcista: 1, acumulacion: 1, lateral: 0.8, sin_datos: 0.75, rebote: 0.6, debil: 0.5, distribucion: 0.4, bajista: 0.25 };
const MIN_TICKET = 10, CRYPTO_CAP = 0.3, ONE_CAP = 0.5, NEW_CAP = 0.25, MAX_LINES = 4;
const shortTxt = (t, n = 230) => !t ? "" : t.length <= n ? t : t.slice(0, t.lastIndexOf(" ", n)) + "…";

function planCandidates() {
  const H = allHoldings();
  const total = H.reduce((a, h) => a + (h.value || 0), 0);
  const recent = (s) => s && Date.now() - new Date(s.at).getTime() < 36 * 3600e3;
  const out = [];
  for (const h of H) {
    const q = h.q || {};
    const sigs = S.signals.filter((s) => s.symbol === h.quote);
    const s = sigs.find((x) => x.by === "ia" && recent(x)) || sigs.find(recent) || sigs[0];
    out.push({ sym: h.symbol, quote: h.quote, name: q.name || h.symbol, held: true, kind: q.kind || (h.source === "Revolut X" ? "crypto" : "stock"),
      value: h.value || 0, share: total ? (h.value || 0) / total : 0, verdict: s ? VERD[s.action] || "mantener" : "mantener", action: s?.action || "mantener",
      conf: s?.confidence ?? 50, phase: q.phase, phaseLabel: q.phaseLabel, rsi: q.rsi14, why: s?.reason || "", sigAt: s?.at });
  }
  // Activos de su cartera que hoy no merecen más dinero
  const weak = out.filter(isWeak);
  // Ideas nuevas: las mejores del escáner que la IA da por buenas y que no tiene ya.
  // Si algo de su cartera flojea, se buscan más (y con algo menos de exigencia) para sustituirlo.
  const held = new Set(H.map((h) => h.quote));
  const minConf = weak.length ? 50 : 60, nIdeas = Math.min(3, 2 + weak.length);
  (S.scan?.items || []).filter((it) => it.verdict === "comprar" && !held.has(it.symbol) && (it.confidence ?? 0) >= minConf).slice(0, nIdeas).forEach((it) =>
    out.push({ sym: it.symbol, quote: it.symbol, name: it.name || it.symbol, held: false, kind: it.kind || "stock", value: 0, share: 0, verdict: "comprar", action: "comprar",
      conf: it.confidence, phase: it.phase, phaseLabel: it.phaseLabel, rsi: it.rsi14, why: it.reason || "", country: it.country }));
  return { list: out, total, weak };
}
const BAD_PH = new Set(["bajista", "debil", "distribucion"]), GOOD_PH = new Set(["alcista", "correccion", "acumulacion"]);
function isWeak(c) { return c.held && (c.verdict === "evitar" || BAD_PH.has(c.phase) || planScore(c) < 0.2); }
function weakWhy(c) {
  if (c.verdict === "evitar") return "las noticias aconsejan no aumentar";
  if (BAD_PH.has(c.phase)) return "está en fase «" + (c.phaseLabel || c.phase) + "»";
  if (c.rsi > 70) return "ha subido demasiado deprisa";
  return c.verdict === "vigilar" ? "la IA aconseja esperar" : "hoy su momento es flojo";
}

function planScore(c) {
  let s = V_BASE[c.verdict] * Math.max(0, Math.min(100, c.conf ?? 50)) / 100 * (PH_MULT[c.phase] ?? 0.75);
  if (c.rsi > 70) s *= 0.6; else if (c.rsi != null && c.rsi < 30 && c.phase !== "bajista") s *= 1.1;
  if (c.held && c.share > 0.5) s *= 0.8;          // ya pesa mucho: no concentrar más
  if (!c.held) s *= 0.9;                          // lo nuevo, con algo más de prudencia
  return s;
}

// Reparte respetando topes; lo que no cabe en ningún sitio queda en reserva
function capFill(items, amount) {
  let left = amount;
  const cap = (c) => Math.min(c.held || c.instead ? (items.length === 1 ? 1 : ONE_CAP) : NEW_CAP, 1) * amount;
  items.forEach((c) => (c.eur = 0));
  for (let round = 0; round < 8 && left > 0.01; round++) {
    const open = items.filter((c) => c.eur < cap(c) - 0.01 && !(c.kind === "crypto" && items.filter((x) => x.kind === "crypto").reduce((a, x) => a + x.eur, 0) >= CRYPTO_CAP * amount - 0.01));
    const sw = open.reduce((a, c) => a + c.w, 0); if (!open.length || !sw) break;
    let used = 0;
    for (const c of open) {
      let add = left * c.w / sw;
      add = Math.min(add, cap(c) - c.eur);
      if (c.kind === "crypto") add = Math.min(add, CRYPTO_CAP * amount - items.filter((x) => x.kind === "crypto").reduce((a, x) => a + x.eur, 0));
      c.eur += Math.max(0, add); used += Math.max(0, add);
    }
    left -= used; if (used < 0.01) break;
  }
  return left;
}

function buildPlan(amount) {
  const { list, total, weak } = planCandidates();
  list.forEach((c) => { c.score = planScore(c); });
  // Si hay una alternativa con señal de compra, el dinero de lo que flojea va a ella
  const alts = list.filter((c) => !c.held);
  if (alts.length) weak.forEach((w, i) => { w.replacedBy = alts[Math.min(i, alts.length - 1)].sym; w.score = 0; alts[Math.min(i, alts.length - 1)].instead = (alts[Math.min(i, alts.length - 1)].instead || []).concat(w.sym); });
  const best = Math.max(0, ...list.map((c) => c.score));
  // Si nada convence, parte se queda esperando una mejor ocasión
  let reserve = best >= 0.4 ? 0 : amount * Math.min(0.6, (0.4 - best) / 0.4 * 0.6);
  let pool = list.filter((c) => c.score > 0.03).sort((a, b) => b.score - a.score).slice(0, MAX_LINES);
  const out = () => list.filter((c) => !pool.includes(c));
  for (let k = 0; k < 6; k++) {
    // Peso: 60 % según la calidad de la señal, 40 % hacia lo que pesa poco en su cartera
    const sum = pool.reduce((a, c) => a + c.score, 0) || 1;
    const inv = amount - reserve, after = total + inv;
    const gaps = pool.map((c) => Math.max(0, c.score / sum * after - c.value));
    const gs = gaps.reduce((a, g) => a + g, 0);
    pool.forEach((c, i) => { c.target = c.score / sum; c.w = 0.6 * c.target + 0.4 * (gs ? gaps[i] / gs : c.target); });
    const extra = capFill(pool, inv);
    const small = pool.filter((c) => c.eur < Math.min(MIN_TICKET, inv)).sort((a, b) => a.eur - b.eur);
    if (small.length && pool.length > 1) { pool = pool.filter((c) => c !== small[0]); small[0].tooSmall = true; continue; }
    reserve += extra; break;
  }
  if (!pool.length) reserve = amount;
  // Redondeo a euros enteros (o céntimos si es poco) cuadrando el total
  const step = amount >= 50 ? 1 : 0.01;
  pool.forEach((c) => (c.eur = Math.round(c.eur / step) * step));
  reserve = pool.length ? Math.round(reserve / step) * step : amount;
  const diff = amount - reserve - pool.reduce((a, c) => a + c.eur, 0);
  if (pool.length && Math.abs(diff) >= step / 2) pool[0].eur += diff;
  pool = pool.filter((c) => c.eur > 0).sort((a, b) => b.eur - a.eur);
  // Sin alternativa comprable: las mejores candidatas a vigilar, para que sepa qué viene
  const held = new Set(list.filter((c) => c.held).map((c) => c.quote));
  const watchAlts = weak.length && !alts.length ? (S.scan?.items || []).filter((it) => it.verdict === "vigilar" && !held.has(it.symbol) && GOOD_PH.has(it.phase))
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0) || (b.score ?? 0) - (a.score ?? 0)).slice(0, 2) : [];
  return { amount, total, pool, reserve, weak, watchAlts, skipped: out().filter((c) => c.held || c.tooSmall) };
}

function planWhy(c, plan) {
  const bits = [];
  if (c.held && c.share > 0.5) bits.push(`ya es el ${fmtPct(c.share, false)} de su cartera, así que le doy algo menos para no concentrar`);
  else if (c.held && plan.total && c.share < (c.target ?? 0) - 0.08) bits.push(`pesa poco en su cartera (${fmtPct(c.share, false)}), así que va reforzándolo`);
  if (c.rsi > 70) bits.push(`RSI ${c.rsi.toFixed(0)}: está caro a corto plazo`);
  if (c.kind === "crypto") bits.push("la cripto se limita al " + Math.round(CRYPTO_CAP * 100) + " % de cada aportación por su volatilidad");
  return bits.join("; ");
}
function skipWhy(c) {
  if (c.replacedBy) return `${weakWhy(c)}, así que este mes su parte va a ${c.replacedBy}, que sí está en punto de compra`;
  if (c.tooSmall) return "le tocaría tan poco que no compensa una operación aparte; lo sumo a las demás";
  if (c.verdict === "evitar") return "las noticias y el análisis aconsejan no aumentar ahora" + (c.why ? ": " + shortTxt(c.why, 160) : "");
  if (c.phase === "bajista") return "está en tendencia bajista: mejor no meter más hasta que gire";
  if (c.rsi > 70) return `RSI ${c.rsi.toFixed(0)}: ha subido demasiado deprisa, mejor esperar`;
  return "esta vez hay opciones con mejor momento";
}

function renderPlan() {
  const box = $("#ap-out"); if (!box) return;
  const amount = parseFloat(String($("#ap-amount").value).replace(",", "."));
  box.replaceChildren();
  if (!S.loaded) return;
  if (!(amount > 0)) { box.append(el("p", { class: "note", text: "Escriba cuánto va a invertir este mes y le propongo el reparto." })); return; }
  const P = buildPlan(amount);
  const fmt = (v) => new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: amount >= 50 ? 0 : 2 }).format(v);
  const parts = [...P.pool.map((c) => ({ k: c.sym, v: c.eur })), ...(P.reserve > 0 ? [{ k: "Reserva", v: P.reserve }] : [])];
  const bar = el("div", { class: "alloc ap-bar" }), leg = el("div", { class: "legend" });
  parts.forEach((p, i) => {
    const col = p.k === "Reserva" ? "var(--muted)" : seriesColor(i);
    bar.append(el("span", { style: `width:${(p.v / amount * 100).toFixed(2)}%;background:${col}` }));
    leg.append(el("span", {}, el("i", { style: `background:${col}` }), `${p.k} `, el("span", { class: "num flat", text: fmtPct(p.v / amount, false) })));
  });
  box.append(bar, leg);
  P.pool.forEach((c) => {
    const why = planWhy(c, P);
    box.append(el("div", { class: "ap-line" },
      avatar(c.quote),
      el("div", { class: "ap-main" },
        el("div", { class: "ap-hd" }, el("b", { text: c.sym }), el("span", { class: "flat", text: c.name }), c.held ? null : el("span", { class: "pill p-buy", text: c.instead ? "En lugar de " + c.instead.join(" y ") : "Nueva" })),
        el("div", { class: "ap-tags" }, actionPill(c.action), c.phaseLabel ? el("span", { class: "flat", text: c.phaseLabel }) : null, el("span", { class: "flat", text: `confianza ${c.conf ?? "—"} %` })),
        c.why ? el("div", { class: "body", text: shortTxt(c.why) }) : null,
        why ? el("div", { class: "body flat", text: "Reparto: " + why + "." }) : null,
        el("div", { class: "ap-where", text: c.kind === "crypto" ? "Comprar en Revolut X" : "Comprar en Revolut Invest" })),
      el("div", { class: "ap-amt" }, el("b", { class: "num", text: fmt(c.eur) }), el("span", { class: "num flat", text: fmtPct(c.eur / amount, false) }))));
  });
  if (P.reserve > 0) box.append(el("div", { class: "ap-line ap-res" },
    el("div", { class: "av", style: "background:var(--sunk);color:var(--muted)", text: "€" }),
    el("div", { class: "ap-main" }, el("div", { class: "ap-hd" }, el("b", { text: "Reserva" })),
      el("div", { class: "body", text: P.pool.length ? "Ahora mismo nada convence lo suficiente para invertirlo todo: guarde esta parte y úsela cuando aparezca una señal de compra." : "Hoy no veo ningún punto de entrada claro. Mejor esperar: le avisaré cuando lo haya." })),
    el("div", { class: "ap-amt" }, el("b", { class: "num", text: fmt(P.reserve) }), el("span", { class: "num flat", text: fmtPct(P.reserve / amount, false) }))));
  if (P.skipped.length) box.append(el("div", { class: "ap-skip" }, el("h3", { text: "Esta vez no" }),
    ...P.skipped.map((c) => el("p", {}, el("b", { text: c.sym + ": " }), skipWhy(c) + "."))));
  if (P.watchAlts.length) {
    const flojos = P.weak.map((c) => `${c.sym} (${weakWhy(c)})`).join(" y ");
    box.append(el("div", { class: "ap-alt" }, el("h3", { text: "Alternativas a " + P.weak.map((c) => c.sym).join(" y ") }),
      el("p", { class: "note", text: `${flojos} no está en su mejor momento. Hoy ninguna empresa del escáner tiene señal clara de compra, así que no le meto dinero aún, pero estas son las que mejor pinta tienen para sustituirlo:` }),
      ...P.watchAlts.map((it) => {
        const watched = S.watch.some((w) => w.symbol === it.symbol);
        return el("div", { class: "ap-line" }, avatar(it.symbol),
          el("div", { class: "ap-main" },
            el("div", { class: "ap-hd" }, el("b", { text: it.symbol }), el("span", { class: "flat", text: it.name || "" })),
            el("div", { class: "ap-tags" }, actionPill("vigilar"), it.phaseLabel ? el("span", { class: "flat", text: it.phaseLabel }) : null, el("span", { class: "flat", text: `confianza ${it.confidence ?? "—"} %` })),
            el("div", { class: "body", text: shortTxt(it.reason || "") }),
            it.watchFor ? el("div", { class: "body", text: "Para entrar: " + it.watchFor }) : null),
          el("div", { class: "ap-amt" }, el("button", { class: "btn small" + (watched ? "" : " primary"), type: "button", text: watched ? "Vigilando" : "Vigilar", onclick: () => watched ? unwatch({ symbol: it.symbol }) : watch(it) })));
      }),
      el("p", { class: "note", text: "Si las pone en vigilancia, le aviso en cuanto entren en punto de compra y pasarán a este reparto." })));
  }
  const sigAt = P.pool.concat(P.skipped).map((c) => c.sigAt).filter(Boolean).sort().at(-1);
  box.append(el("p", { class: "note", text: `Calculado con las señales de ${sigAt ? ago(sigAt) : "—"} y el escáner de ${S.scan?.at ? ago(S.scan.at) : "—"}. Si un activo no aparece, es que hoy no está en buen momento. Es una propuesta orientativa, no asesoramiento financiero: las compras las hace usted en Revolut, y pocas operaciones grandes cuestan menos en comisiones que muchas pequeñas.` }));
}

(function planPanel() {
  const saved = lsGet(AP_LS) || "";
  const inp = el("input", { id: "ap-amount", type: "number", min: "0", step: "10", inputmode: "decimal", placeholder: "200", value: saved });
  inp.addEventListener("input", () => { lsSet(AP_LS, inp.value || null); renderPlan(); });
  const panel = el("div", { class: "panel", id: "aporte" },
    el("h2", {}, "Aportación del mes", el("small", { text: "dígame cuánto va a invertir y le digo cómo repartirlo" })),
    el("div", { class: "ap-form" }, el("label", { class: "field" }, "Cantidad a invertir (€)", inp),
      el("div", { class: "ap-quick" }, [100, 200, 300, 500].map((v) => el("button", { class: "chip", type: "button", text: v + " €", onclick: () => { inp.value = v; lsSet(AP_LS, String(v)); renderPlan(); } })))),
    el("div", { id: "ap-out" }));
  $("#v-oportunidades").prepend(panel);
  const q = $(".quick");
  if (q) q.append(el("a", { class: "wide", href: "#oportunidades", onclick: () => setTimeout(() => $("#aporte")?.scrollIntoView({ behavior: "smooth" }), 80) }, svgIcon('<path d="M12 3v18M17 7H9.5a3 3 0 0 0 0 6h5a3 3 0 0 1 0 6H6"/>'), "Invertir este mes"));
})();
const _renderOpp3 = renderOpportunities;
renderOpportunities = () => { _renderOpp3(); renderPlan(); };

// ---- Mercado hoy: noticias que mueven el mercado, escenarios, régimen cripto y fechas clave ----
// Lo escribe la capa de IA con las skills market-news-analyst, scenario-analyzer, catalyst-calendar
// y crypto-regime-analyzer. Todo son datos públicos de mercado.
const ZONE_ES = { "RISK-ON": ["Apetito por el riesgo", "gain"], "STRONG RISK-ON": ["Mucho apetito por el riesgo", "gain"], "HEALTHY": ["Sano", "gain"], "NEUTRAL": ["Neutral", "flat"], "CAUTION": ["Precaución", "loss"], "RISK-OFF": ["Aversión al riesgo", "loss"], "CRITICAL": ["Muy negativo", "loss"] };
const COMP_ES = { btc_trend: "Tendencia de BTC", alt_breadth: "Amplitud de altcoins", dominance: "Dominancia de BTC", funding: "Apalancamiento", drawdown_vol: "Caída y volatilidad", momentum_thrust: "Impulso" };
const REG_ES = { "risk-on": ["Apetito por el riesgo", "gain"], neutral: ["Neutral", "flat"], "risk-off": ["Aversión al riesgo", "loss"] };
const IMP_ES = { alto: "loss", medio: "warn", bajo: "flat", high: "loss", medium: "warn", low: "flat" };
const fmtD = (d) => { const t = new Date(d); return isNaN(t) ? d : t.toLocaleDateString("es-ES", { day: "numeric", month: "short" }); };
function upcomingCatalysts() {
  const held = new Set(allHoldings().map((h) => h.quote));
  const out = [];
  for (const c of S.market?.catalysts || []) out.push({ ...c, sym: null });
  // Las fechas de sus valores; si el panorama general ya trae ese mismo día, no se repite
  const mkDays = new Set(out.map((c) => c.d));
  for (const [sym, a] of Object.entries(S.analysis || {})) if (held.has(sym)) for (const c of a.catalysts || []) if (!mkDays.has(c.d)) out.push({ ...c, sym });
  const today = new Date(new Date().toDateString());
  return out.filter((c) => { const t = new Date(c.d); return isNaN(t) || t >= today; })
    .sort((a, b) => String(a.d).localeCompare(String(b.d))).slice(0, 6);
}
function renderMarketToday() {
  let p = $("#hoy-mkt");
  const M = S.market, R = S.cryptoRegime;
  if (!M && !R) { if (p) p.remove(); return; }
  if (!p) { p = el("div", { class: "panel", id: "hoy-mkt" }); $("#positions").after(p); }
  p.replaceChildren(el("h2", {}, "Mercado hoy", el("small", { text: M?.at ? ` · análisis de ${ago(M.at)}` : "" })));
  if (M) {
    const rg = REG_ES[(M.regime || "").toLowerCase()];
    if (rg) p.append(el("div", { class: "hm-reg" }, el("span", { class: "pill hm-" + rg[1], text: rg[0] })));
    if (M.summary) p.append(el("p", { class: "hm-sum", text: M.summary }));
    if (M.events?.length) {
      p.append(el("h3", { text: "Noticias que mueven el mercado" }));
      const ul = el("ul", { class: "hm-ev" });
      for (const e of M.events) ul.append(el("li", {}, el("i", { class: "hm-dot hm-" + (IMP_ES[(e.impact || "").toLowerCase()] || "flat"), title: "Impacto " + (e.impact || "") }),
        el("div", {}, e.u ? el("a", { href: e.u, target: "_blank", rel: "noopener", text: e.t }) : el("b", { text: e.t }), e.affects ? el("span", { class: "flat", text: " · " + e.affects }) : null)));
      p.append(ul);
    }
    if (M.scenarios?.length) {
      p.append(el("h3", { text: "Escenarios" }));
      for (const sc of M.scenarios) p.append(el("div", { class: "hm-sc" }, el("div", { class: "hm-sch" }, el("b", { text: sc.name }), el("span", { class: "num flat", text: `${sc.prob} %` })),
        el("div", { class: "hm-bar" }, el("span", { style: `width:${sc.prob}%` })), sc.effect ? el("div", { class: "body flat", text: sc.effect }) : null));
    }
  }
  if (R) {
    const z = ZONE_ES[String(R.zone || "").toUpperCase()] || [R.zone, "flat"];
    p.append(el("h3", { text: "Mercado cripto" }));
    p.append(el("div", { class: "hm-cr" }, el("div", { class: "hm-score num " + z[1], text: String(Math.round(R.score)) }),
      el("div", {}, el("b", { text: z[0] }), el("div", { class: "flat", text: `Régimen 0–100 · ${ago(R.at)}` }))));
    const comp = el("div", { class: "hm-comp" });
    for (const [k, c] of Object.entries(R.components || {})) if (c.ok) comp.append(el("div", {}, el("span", { text: COMP_ES[k] || k }), el("div", { class: "hm-bar" }, el("span", { style: `width:${c.score}%` })), el("span", { class: "num flat", text: String(c.score) })));
    p.append(comp);
    if (M?.crypto) p.append(el("p", { class: "body", text: M.crypto }));
  }
  const cats = upcomingCatalysts();
  if (cats.length) {
    p.append(el("h3", { text: "Próximas fechas clave" }));
    const ul = el("ul", { class: "hm-cat" });
    for (const c of cats) ul.append(el("li", {}, el("span", { class: "num hm-d", text: fmtD(c.d) }), el("span", {}, c.sym ? el("b", { text: c.sym.replace(/-EUR$/, "") + " · " }) : null, c.e)));
    p.append(ul);
  }
  p.append(el("p", { class: "note", text: "Lectura orientativa del mercado con IA y datos públicos; no es asesoramiento financiero." }));
}
// Tesis de inversión: por qué, qué la rompería, valoración y fechas, en señales e ideas
function thesisBlock(sym) {
  const a = S.analysis?.[sym];
  if (!a || !(a.thesis || a.breaks || a.valuation)) return null;
  const b = el("div", { class: "thesis" });
  if (a.thesis) b.append(el("div", { class: "body" }, el("b", { text: "Por qué invertir: " }), a.thesis));
  if (a.breaks) b.append(el("div", { class: "body" }, el("b", { text: "Qué lo cambiaría: " }), a.breaks));
  if (a.valuation) b.append(el("div", { class: "body flat" }, el("b", { text: "Valoración: " }), a.valuation));
  if (a.catalysts?.length) b.append(el("div", { class: "body flat" }, el("b", { text: "Fechas: " }), a.catalysts.map((c) => `${fmtD(c.d)} ${c.e}`).join(" · ")));
  return b;
}
const _signalNode2 = signalNode;
signalNode = (s, compact) => {
  const n = _signalNode2(s, compact);
  if (!compact && s.by === "ia") { const t = thesisBlock(s.symbol); if (t) n.append(t); }
  return n;
};
const _renderOpp4 = renderOpportunities;
renderOpportunities = () => {
  _renderOpp4();
  document.querySelectorAll("#scan-list .opp").forEach((o) => {
    if (o.querySelector(".thesis")) return;
    const sym = o.querySelector(".hd b")?.textContent; const t = sym && thesisBlock(sym);
    if (t) o.append(t);
  });
};
const _renderAll2 = renderAll;
renderAll = () => { _renderAll2(); renderMarketToday(); };

const readOnly = () => Promise.reject({ message: "en la app del móvil solo se consulta; cámbielo en la dashboard de Claude" });
const stubDb = { doc: () => ({ set: readOnly, update: readOnly, delete: readOnly }) };

function lockScreen(msg = "") {
  document.querySelector(".lock")?.remove();
  const input = el("input", { id: "pwa-key", placeholder: "XXXX-XXXX-XXXX-XXXX", autocomplete: "off", autocapitalize: "characters", spellcheck: "false", inputmode: "text" });
  const err = el("div", { class: "err", text: msg });
  const go = el("button", { class: "btn primary", type: "button", text: "Abrir" });
  const submit = async () => {
    const k = normKey(input.value);
    if (k.length < 12) { err.textContent = "La clave tiene 16 caracteres."; return; }
    go.disabled = true; err.textContent = "";
    const ok = await pwaLoad(k);
    go.disabled = false;
    if (ok) { lsSet(KEY_LS, k); document.querySelector(".lock")?.remove(); }
    else err.textContent = "Esa clave no abre sus datos.";
  };
  go.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  document.body.appendChild(el("div", { class: "lock" },
    el("div", { class: "card" },
      el("span", { class: "eye", "aria-hidden": "true" }),
      el("h2", { text: "Centinela" }),
      el("p", { class: "note", text: "Escriba su clave de acceso. Solo se pide la primera vez en este móvil." }),
      input, go, err)));
  setTimeout(() => input.focus(), 50);
}

async function decryptBundle(k, env) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(k), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: b64(env.salt), iterations: env.iter }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(env.iv) }, key, b64(env.ct));
  return JSON.parse(new TextDecoder().decode(plain));
}

async function pwaLoad(k) {
  if (pwaLoading) return false;
  pwaLoading = true;
  try {
    const r = await fetch("data.enc.json?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await decryptBundle(k, await r.json());
    S.ledger = d.ledger; S.crypto = d.crypto; S.settings = d.settings || {};
    S.positions = { manual: [], cryptoCost: {}, ...(d.positions || {}) };
    S.scan = d.scan; S.status = d.status; S.quotes = d.quotes || {};
    S.signals = d.signals || []; S.watch = d.watch || [];
    S.market = d.market || null; S.analysis = d.analysis || {}; S.cryptoRegime = d.cryptoRegime || null;
    if (d.ntfyTopic && !S.settings.ntfyTopic) S.settings.ntfyTopic = d.ntfyTopic;
    pwaDash = d.dashboardUrl || null; pwaLastAt = d.at; pwaLogos = d.logos || {}; pwaFinnhub = d.finnhubKey || null;
    pwaTopic = d.ntfyTopic || S.settings.ntfyTopic || null; applyPending();
    db = stubDb; S.loaded = true;
    renderAll(); appPanel(); startLive();
    if (!$("#v-cartera").hidden) requestAnimationFrame(drawEvolution);
    return true;
  } catch (e) {
    if (e && e.name === "OperationError") return false;      // clave incorrecta
    if (!navigator.onLine) toast("Sin conexión: muestro lo último guardado");
    else toast("No se pudieron cargar los datos", true);
    return e && e.name !== "OperationError" && S.loaded;
  } finally { pwaLoading = false; }
}

function appPanel() {
  let p = $("#pwa-panel");
  if (!p) {
    p = el("div", { class: "panel", id: "pwa-panel" });
    $("#v-ajustes").prepend(p);
  }
  p.replaceChildren(
    el("h2", { text: "App del móvil" }),
    el("p", { class: "note", text: "Bitcoin y las criptos de Revolut X se actualizan solas. Si compra o vende acciones en Revolut Invest, suba el Extracto de cuenta (CSV) a Drive › Inversiones › 01 Extractos Revolut › Invest y pídale a Claude que lo importe." }),
    el("p", { class: "note", text: "El motor revisa su cartera cada hora y el mercado cada mañana, sin necesidad de su PC. El análisis de noticias con IA se añade cada día a las 08:00." }),
    el("div", { style: "display:flex;gap:8px;flex-wrap:wrap" },
      el("button", { class: "btn small", type: "button", text: "Actualizar ahora", onclick: () => refresh(true) }),
      el("button", { class: "btn small", type: "button", text: "Olvidar la clave", onclick: () => { lsSet(KEY_LS, null); location.reload(); } })),
    el("p", { class: "note", text: pwaLastAt ? "Datos publicados " + ago(pwaLastAt) + "." : "" }));
  // Clave de Finnhub para precios de acciones en directo (solo se guarda en este móvil)
  const has = !!(lsGet(FH_LS) || pwaFinnhub);
  const inp = el("input", { id: "fh-key", placeholder: has ? "Clave guardada · escriba otra para cambiarla" : "Pegue aquí su clave de Finnhub", autocomplete: "off", spellcheck: "false" });
  let lp = $("#live-panel");
  if (!lp) { lp = el("div", { class: "panel", id: "live-panel" }); p.after(lp); }
  const form = el("div", { class: "form" },
    el("label", { class: "field" }, "Clave de Finnhub", inp),
    el("button", { class: "btn primary", type: "button", text: "Guardar", onclick: () => { const v = inp.value.trim(); if (!/^[A-Za-z0-9]{10,}$/.test(v)) { toast("Esa clave no parece válida", true); return; } lsSet(FH_LS, v); inp.value = ""; toast("Clave guardada en este móvil"); appPanel(); liveTick(); } }),
    lsGet(FH_LS) ? el("button", { class: "btn", type: "button", text: "Quitar la de este móvil", onclick: () => { lsSet(FH_LS, null); appPanel(); } }) : "");
  const live = Date.now() - liveAt < 60000;
  const ok = (t, d) => el("div", { class: "status-row" }, el("span", { text: t }), el("span", { class: "up", text: d }));
  if (has) {
    // Ya configurado: estado y, solo si lo pide, el formulario para cambiar la clave
    form.hidden = true;
    lp.replaceChildren(
      el("h2", { text: "Precios en directo" }),
      ok("Criptomonedas (Binance)", "✓ activo"),
      ok("Acciones (Finnhub)", "✓ clave configurada"),
      el("p", { class: "note", text: live ? "Actualizándose ahora cada 15 segundos mientras la app está abierta." : "Se actualizan cada 15 segundos mientras la app está abierta y el mercado cotiza." }),
      el("button", { class: "btn small", type: "button", text: "Cambiar clave", onclick: (e) => { form.hidden = false; e.target.remove(); } }),
      form);
  } else {
    lp.replaceChildren(
      el("h2", { text: "Precios en directo" }),
      ok("Criptomonedas (Binance)", "✓ activo"),
      el("p", { class: "note" }, "Para las acciones hace falta una clave gratuita de Finnhub: regístrese en ", el("a", { href: "https://finnhub.io/register", target: "_blank", rel: "noopener", text: "finnhub.io" }), ", copie su «API key» y péguela aquí."),
      form);
  }
}

async function refresh(manual = false) {
  const k = lsGet(KEY_LS);
  if (!k) return;
  const ok = await pwaLoad(k);
  if (manual && ok) toast("Datos al día");
}

function pwaStart() {
  db = null; S.loaded = false; renderFresh();
  const m = location.hash.match(/[#&]k=([A-Za-z0-9-]+)/);
  if (m) { lsSet(KEY_LS, normKey(m[1])); history.replaceState(null, "", location.pathname + "#cartera"); route(); }
  const k = lsGet(KEY_LS);
  if (!k) lockScreen();
  else pwaLoad(k).then((ok) => { if (!ok && !S.loaded) { lsSet(KEY_LS, null); lockScreen("La clave guardada ya no sirve. Escríbala de nuevo."); } });
  $("#fresh").addEventListener("click", () => refresh(true));
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });
  setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 10 * 60 * 1000);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}
