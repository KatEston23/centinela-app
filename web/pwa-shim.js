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
    tds[2].classList.add("c-hide"); tds[4].classList.add("c-hide");
    tds[7].querySelector("svg")?.setAttribute("preserveAspectRatio", "none");
    tr.prepend(el("td", { class: "c-av" }, avatar(sym)));
  });
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
    if (d.ntfyTopic && !S.settings.ntfyTopic) S.settings.ntfyTopic = d.ntfyTopic;
    pwaDash = d.dashboardUrl || null; pwaLastAt = d.at; pwaLogos = d.logos || {}; pwaFinnhub = d.finnhubKey || null;
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
  lp.replaceChildren(
    el("h2", { text: "Precios en directo" }),
    el("p", { class: "note", text: "Con la app abierta, los precios de su cartera se actualizan cada 15 segundos. Bitcoin y otras criptos ya funcionan. Para las acciones hace falta una clave gratuita de Finnhub." }),
    el("p", { class: "note" }, "1. Regístrese gratis en ", el("a", { href: "https://finnhub.io/register", target: "_blank", rel: "noopener", text: "finnhub.io" }), ". 2. Copie su «API key» del panel. 3. Péguela aquí:"),
    el("div", { class: "form" },
      el("label", { class: "field" }, "Clave de Finnhub", inp),
      el("button", { class: "btn primary", type: "button", text: "Guardar", onclick: () => { const v = inp.value.trim(); if (!/^[A-Za-z0-9]{10,}$/.test(v)) { toast("Esa clave no parece válida", true); return; } lsSet(FH_LS, v); inp.value = ""; toast("Clave guardada en este móvil"); appPanel(); liveTick(); } }),
      lsGet(FH_LS) ? el("button", { class: "btn", type: "button", text: "Quitar", onclick: () => { lsSet(FH_LS, null); appPanel(); } }) : ""),
    el("p", { class: "note", text: has ? "Acciones en directo: activas." : "Acciones en directo: pendientes de la clave." }));
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
