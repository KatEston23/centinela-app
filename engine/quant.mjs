// Análisis cuantitativo de «euforia» y «pánico» con estadística propia de cada activo (Yahoo, 5 años).
//
// Por qué: el 23-11-2026 NVDA subió un +31 % en un día con el regreso de Huang y el sistema dijo
// «mantener»; en dos días devolvió la subida. Tras un salto extremo (varias desviaciones típicas en
// 1-5 sesiones) lo habitual es que el precio devuelva parte: recogida de beneficios y fin de la noticia.
// Aquí se detecta ese salto y se mide, en el pasado del mismo activo, qué pasó después de saltos
// parecidos (cuántas veces bajó a 10 sesiones, cuánto devolvió). Con pocos casos, la estadística se
// acerca a la tasa general de reversión (55 %) en vez de fiarse de 2-3 ejemplos.
import { fetchChart } from "./lib.mjs";

const WINDOWS = [1, 2, 3, 5];        // sesiones en las que se mide el salto
const SIGMA_MIN = 3;                  // salto ≥ 3 desviaciones típicas de su volatilidad reciente
const LOOKBACK_EVENT = 10;            // un episodio sigue «vivo» hasta 10 sesiones después
const PRIOR_P = 0.55, PRIOR_W = 6;    // reversión «de manual» y su peso (pseudocasos)
const H = 10;                         // horizonte principal (sesiones)

const round = (x, d = 4) => (x == null || !isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const std = (a) => { if (a.length < 2) return null; const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };

/** Salto más extremo que termina en el índice i: { n, ret, sig } (sig en desviaciones típicas). */
function jumpAt(c, i, sd) {
  let best = null;
  for (const n of WINDOWS) {
    if (i - n < 0 || !sd) continue;
    const lr = Math.log(c[i] / c[i - n]), sig = lr / (sd * Math.sqrt(n));
    if (!best || Math.abs(sig) > Math.abs(best.sig)) best = { n, ret: c[i] / c[i - n] - 1, sig };
  }
  return best;
}
// Volatilidad diaria de las 60 sesiones ANTERIORES al índice (sin contar el propio salto)
function sdBefore(lr, i) { const a = lr.slice(Math.max(0, i - 61), Math.max(0, i - 1)); return a.length >= 20 ? std(a) : null; }

// Tendencia de fondo en el índice i: +1 sobre su media de 200 sesiones, -1 por debajo, 0 sin datos
function trendAt(c, i) {
  if (i < 200) return 0;
  let s = 0; for (let k = i - 199; k <= i; k++) s += c[k];
  return c[i] > s / 200 ? 1 : -1;
}

function isEvent(j, dir, minMove) { return j && Math.sign(j.sig) === dir && Math.abs(j.sig) >= SIGMA_MIN && Math.abs(j.ret) >= minMove; }

/** Qué pasó después de saltos parecidos en la historia del activo (sin solaparse y sin el episodio actual). */
function backtest(c, lr, dir, minMove, skipFrom) {
  const out = [];
  for (let i = 65; i < Math.min(c.length - 21, skipFrom); i++) {
    const j = jumpAt(c, i, sdBefore(lr, i));
    if (!isEvent(j, dir, minMove)) continue;
    const pre = c[i - j.n], p0 = c[i];
    const f5 = c[i + 5] / p0 - 1, f10 = c[i + H] / p0 - 1, f20 = c[i + 20] / p0 - 1;
    const win = c.slice(i + 1, i + 21);
    const ext = dir > 0 ? Math.min(...win) : Math.max(...win);
    const give = (p0 - ext) / (p0 - pre); // fracción del salto devuelta en 20 sesiones (en el peor punto)
    out.push({ i, f5, f10, f20, give, trend: trendAt(c, i - j.n) });
    i += LOOKBACK_EVENT; // un episodio por vez
  }
  return out;
}

/**
 * @param {string} yahooSym símbolo en Yahoo (p. ej. NVDA, BTC-EUR, MON30495-USD)
 * @param {{kind?:string, price?:number}} opts precio actual (con preapertura si la hay)
 */
export async function quant(yahooSym, opts = {}) {
  const r = await fetchChart(yahooSym, "5y");
  const ts = r.timestamp || [], raw = r.indicators?.quote?.[0]?.close || [], rawV = r.indicators?.quote?.[0]?.volume || [];
  const c = [], v = [], t = [];
  for (let i = 0; i < ts.length; i++) if (raw[i] != null) { c.push(raw[i]); v.push(rawV[i] ?? null); t.push(ts[i]); }
  if (opts.dropLast) { c.splice(-opts.dropLast); v.splice(-opts.dropLast); t.splice(-opts.dropLast); } // pruebas: «como si fuera» N sesiones atrás
  if (opts.price && c.length) c[c.length - 1] = opts.price;
  if (c.length < 120) return { ok: false, why: "historia corta" };
  const crypto = opts.kind === "crypto" || r.meta?.instrumentType === "CRYPTOCURRENCY";
  const minMove = crypto ? 0.12 : 0.08; // un salto tiene que ser grande también en términos absolutos
  const lr = []; for (let i = 1; i < c.length; i++) lr.push(Math.log(c[i] / c[i - 1]));
  lr.unshift(0); // lr[i] = rendimiento del día i
  const last = c.length - 1, price = c[last];

  // Extensión frente a su media de 20 sesiones, en desviaciones típicas del precio
  const w20 = c.slice(-20), m20 = w20.reduce((a, b) => a + b, 0) / 20, s20 = std(w20);
  const z20 = s20 ? (price - m20) / s20 : null;
  const vAvg = v.slice(-21, -1).filter((x) => x != null);
  const volRatio = vAvg.length > 10 && v[last] ? v[last] / (vAvg.reduce((a, b) => a + b, 0) / vAvg.length) : null;

  // Episodio vivo: el salto más reciente (≥ 3σ) en las últimas 10 sesiones, hacia arriba o hacia abajo
  let ev = null;
  for (let i = last; i >= Math.max(65, last - LOOKBACK_EVENT); i--) {
    const j = jumpAt(c, i, sdBefore(lr, i));
    if (isEvent(j, 1, minMove) || isEvent(j, -1, minMove)) { ev = { i, ...j, dir: Math.sign(j.sig) }; break; }
  }
  const base = { ok: true, z20: round(z20, 2), volRatio: round(volRatio, 2), sdDaily: round(std(lr.slice(-60)), 4) };
  if (!ev) return { ...base, state: "normal" };

  const pre = c[ev.i - ev.n];
  const seg = c.slice(ev.i);
  const peak = ev.dir > 0 ? Math.max(...seg) : Math.min(...seg);
  const moved = peak / pre - 1;
  const givenBack = peak !== pre ? (peak - price) / (peak - pre) : 0; // 0 = sigue en el extremo; 1 = volvió al punto de partida
  const daysSince = last - ev.i;

  const all = backtest(c, lr, ev.dir, minMove, ev.i - 5);
  // Contexto: un salto con la tendencia de fondo a favor no es lo mismo que un rebote dentro de una
  // tendencia bajista (lo de NVDA el 23-11: rebote tras pánico, que se desinfló). Si hay casos
  // suficientes en el mismo contexto, se usan solo esos.
  const trend = trendAt(c, ev.i - ev.n);
  const same = all.filter((h) => h.trend === trend);
  const hist = trend && same.length >= 5 ? same : all;
  const n = hist.length;
  // «Revierte» = a 10 sesiones está peor (tras subida) o mejor (tras caída) que el día del salto
  const k = hist.filter((h) => (ev.dir > 0 ? h.f10 < 0 : h.f10 > 0)).length;
  const pRevert = (k + PRIOR_P * PRIOR_W) / (n + PRIOR_W);
  // «Devuelve la mitad» = en algún momento de las 20 sesiones siguientes pierde ≥ 50 % del salto.
  // Es lo que importa para recoger beneficios: vender una parte y poder recomprar más barato.
  const kHalf = hist.filter((h) => h.give >= 0.5).length;
  const pHalf = (kHalf + 0.5 * PRIOR_W) / (n + PRIOR_W);
  const stats = {
    n, k, pRevert: round(pRevert, 3), kHalf, pHalf: round(pHalf, 3), context: trend > 0 ? "alcista" : trend < 0 ? "bajista" : "", sameContext: hist === same,
    median10: round(median(hist.map((h) => h.f10)), 4),
    median20: round(median(hist.map((h) => h.f20)), 4),
    giveBack20: round(median(hist.map((h) => h.give)), 3),
  };
  // Niveles: punto de partida, mitad del salto y retroceso del 38 %
  const levels = { pre: round(pre, 4), half: round(pre + (peak - pre) * 0.5, 4), fib38: round(peak - (peak - pre) * 0.382, 4), peak: round(peak, 4) };
  return {
    ...base,
    state: ev.dir > 0 ? "euforia" : "panico",
    event: { day: new Date(t[ev.i] * 1000).toISOString().slice(0, 10), daysAgo: daysSince, sessions: ev.n, move: round(moved, 4), sigma: round(Math.abs(ev.sig), 1), givenBack: round(givenBack, 3) },
    stats, levels,
  };
}

const pc = (v) => `${v > 0 ? "+" : ""}${(v * 100).toFixed(1).replace(".", ",")} %`;

/**
 * Señal a partir del análisis cuantitativo. held = el usuario lo tiene.
 * Devuelve { action, entry, confidence, title, reason, risk, code } o null si no hay nada que decir.
 */
export function quantSignal(name, Q, { held, gainPct = null, money = (x) => x.toFixed(2), rsi = null } = {}) {
  if (!Q?.ok || Q.state === "normal") return null;
  const { event: e, stats: s, levels: L } = Q;
  const ctx = s.sameContext && s.context ? ` con la tendencia de fondo ${s.context}` : "";
  const hist = s.n
    ? `En ${s.n} ${s.n === 1 ? "salto parecido" : "saltos parecidos"} de sus últimos 5 años${ctx}, devolvió al menos la mitad en las 20 sesiones siguientes ${s.kHalf} de ${s.n} veces (mediana devuelta: ${Math.round((s.giveBack20 ?? 0) * 100)} %); a 10 sesiones ${Q.state === "euforia" ? "estaba más bajo" : "estaba más alto"} en ${s.k} (mediana ${pc(s.median10 ?? 0)}).`
    : "No hay saltos parecidos en sus últimos 5 años; se aplica la tasa general de reversión.";
  const prob = Math.round(s.pRevert * 100), probHalf = Math.round(s.pHalf * 100);
  // Rebote dentro de una tendencia bajista: el contexto que peor acaba para el que compra la euforia
  const counterTrend = s.context === "bajista";
  if (Q.state === "euforia") {
    if (e.givenBack >= 0.6) {
      // La reversión ya ocurrió: no tiene sentido vender ahora por la euforia
      return { code: "euforia_agotada", action: held ? "mantener" : "vigilar", entry: "vigilar", confidence: 50,
        title: `${name}: la euforia ya se ha deshinchado`,
        reason: `Subió ${pc(e.move)} en ${e.sessions} ${e.sessions === 1 ? "sesión" : "sesiones"} hace ${e.daysAgo} y ya ha devuelto el ${Math.round(e.givenBack * 100)} % (punto de partida ${money(L.pre)}). ${hist}`,
        risk: "Si pierde el punto de partida del salto, el mercado estaría descontando que la noticia no cambia nada." };
    }
    // Confianza: probabilidad histórica de devolver la mitad (lo que importa para recoger beneficios),
    // matizada por la de cerrar más bajo a 10 sesiones, el contexto y lo extendido que está
    let conf = 45 + (s.pHalf - 0.5) * 80 + (s.pRevert - 0.5) * 40;
    if (counterTrend) conf += 8;
    if (e.sigma >= 5) conf += 6;
    if ((Q.z20 ?? 0) >= 2.5) conf += 5;
    if (rsi != null && rsi >= 75) conf += 5;
    if (e.givenBack < 0.2) conf += 4;
    conf = Math.round(Math.max(50, Math.min(85, conf)));
    const sellPart = conf >= 70 ? "un tercio" : "una cuarta parte";
    const gain = gainPct != null && gainPct > 0 ? ` Va ganando un ${pc(gainPct)}: es el momento de asegurar parte.` : "";
    return held
      ? { code: "euforia", action: "reducir", entry: "evitar", confidence: conf,
          title: `${name}: euforia, recoger parte de beneficios`,
          reason: `Salto de ${pc(e.move)} en ${e.sessions} ${e.sessions === 1 ? "sesión" : "sesiones"} (${e.sigma} veces su volatilidad normal). ${hist}${counterTrend ? " Es un rebote dentro de una tendencia bajista: los que acaban desinflándose." : ""} Probabilidad estimada de que devuelva la mitad: ${probHalf} %.${gain} Plan: vender ${sellPart} y dejar el resto con salida si cae por debajo de ${money(L.half)} (mitad del salto).`,
          risk: `Si la noticia cambia de verdad el negocio, puede seguir subiendo: por eso se vende solo una parte. Retroceso probable hacia ${money(L.fib38)}–${money(L.half)}.` }
      : { code: "euforia", action: "vigilar", entry: "evitar", confidence: conf,
          title: `${name}: no comprar en plena euforia`,
          reason: `Salto de ${pc(e.move)} en ${e.sessions} ${e.sessions === 1 ? "sesión" : "sesiones"} (${e.sigma} veces su volatilidad normal). ${hist} Probabilidad estimada de que devuelva la mitad: ${probHalf} %. Mejor esperar un retroceso hacia ${money(L.fib38)}–${money(L.half)}.`,
          risk: "Si la subida responde a un cambio real del negocio, puede no volver a esos niveles." };
  }
  // Pánico: caída extrema. Si su historia dice que suele rebotar, vender en el peor momento sale caro;
  // si dice que NO rebota (valores que caen y siguen cayendo), no se tranquiliza a nadie.
  if (e.givenBack >= 0.6) return null; // ya rebotó
  const pr = s.pRevert;
  if (pr >= 0.55) {
    const conf = Math.round(Math.max(50, Math.min(80, 40 + (pr - 0.5) * 120 + (rsi != null && rsi <= 25 ? 5 : 0))));
    return held
      ? { code: "panico", action: "mantener", entry: "vigilar", confidence: conf,
          title: `${name}: caída extrema, no vender en pánico`,
          reason: `Cae ${pc(e.move)} en ${e.sessions} ${e.sessions === 1 ? "sesión" : "sesiones"} (${e.sigma} veces su volatilidad normal). ${hist} Probabilidad estimada de rebote: ${prob} %. Salvo que la noticia rompa la tesis, vender ahora suele ser vender en el peor punto.`,
          risk: `Si la causa es estructural (fraude, pérdida de un cliente clave, regulación), el rebote puede no llegar. Referencia: ${money(L.pre)} antes de la caída.` }
      : { code: "panico", action: "vigilar", entry: "vigilar", confidence: conf,
          title: `${name}: caída extrema, posible rebote`,
          reason: `Cae ${pc(e.move)} en ${e.sessions} ${e.sessions === 1 ? "sesión" : "sesiones"}. ${hist} Probabilidad estimada de rebote: ${prob} %. Esperar a que se estabilice (dos cierres sin mínimos nuevos) antes de entrar.`,
          risk: "Comprar una caída sin conocer la causa es intentar coger un cuchillo que cae." };
  }
  // Sin patrón de rebote: la caída suele continuar. Revisar la tesis y decidir con un límite de pérdida.
  const conf = Math.round(Math.max(50, Math.min(75, 50 + (0.5 - pr) * 100)));
  return held
    ? { code: "panico_sin_rebote", action: "vigilar", entry: "evitar", confidence: conf,
        title: `${name}: caída extrema sin patrón de rebote`,
        reason: `Cae ${pc(e.move)} en ${e.sessions} ${e.sessions === 1 ? "sesión" : "sesiones"} (${e.sigma} veces su volatilidad normal). ${hist} Probabilidad estimada de rebote: solo ${prob} %: en este valor las caídas así suelen continuar. Revise si la causa rompe la tesis; si sigue dentro, fije un límite: salir si cierra por debajo de ${money(L.peak * 0.9)} (un 10 % bajo el mínimo).`,
        risk: "Vender tras una caída así puede ser vender en el mínimo; mantener sin límite puede costar mucho más." }
    : { code: "panico_sin_rebote", action: "vigilar", entry: "evitar", confidence: conf,
        title: `${name}: caída extrema, no hay patrón de rebote`,
        reason: `Cae ${pc(e.move)} en ${e.sessions} ${e.sessions === 1 ? "sesión" : "sesiones"}. ${hist} Probabilidad estimada de rebote: solo ${prob} %. No es una oportunidad hasta que deje de marcar mínimos.`,
        risk: "Comprar una caída sin conocer la causa es intentar coger un cuchillo que cae." };
}
