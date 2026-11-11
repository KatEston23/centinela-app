// Uso: node engine/scan.mjs [top=20]
// Puntúa todo el universo con criterios técnicos (tendencia, momentum, retroceso sano,
// RSI, volumen) y escribe out/scan-candidates.json. El análisis de noticias de los
// finalistas lo hace después la rutina programada.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, analyze, mapLimit } from "./lib.mjs";
import { UNIVERSE } from "./universe.mjs";

const top = Number(process.argv[2] || 20);
const at = new Date().toISOString();
const rows = await mapLimit(UNIVERSE.map((u) => u[0]), 6, analyze);
const country = Object.fromEntries(UNIVERSE);

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const scored = [];
for (const q of rows) {
  if (!q || q.error || q.price == null) continue;
  const reasons = [];
  let s = 50;
  // Tendencia de fondo
  if (q.sma200 && q.price > q.sma200) { s += 10; reasons.push("por encima de su media de 200"); } else if (q.sma200) s -= 10;
  if (q.sma50 && q.sma200 && q.sma50 > q.sma200) { s += 6; reasons.push("medias en tendencia alcista"); }
  // Momentum de 3 meses, con tope
  if (q.change90d != null) { s += clamp(q.change90d * 60, -15, 15); if (q.change90d > 0.15) reasons.push(`+${(q.change90d * 100).toFixed(0)} % en 3 meses`); }
  // Retroceso sano dentro de tendencia alcista = posible punto de entrada
  if (q.drawdown != null && q.drawdown <= -0.08 && q.drawdown >= -0.3 && q.sma200 && q.price > q.sma200 * 0.97) {
    s += 10; reasons.push(`retrocede ${(q.drawdown * -100).toFixed(0)} % desde máximos con la tendencia intacta`);
  }
  if (q.drawdown != null && q.drawdown < -0.45) s -= 8;
  // RSI
  if (q.rsi14 != null) {
    if (q.rsi14 < 35 && q.sma200 && q.price > q.sma200 * 0.95) { s += 8; reasons.push(`RSI ${q.rsi14.toFixed(0)} (sobreventa)`); }
    if (q.rsi14 > 75) { s -= 8; reasons.push(`RSI ${q.rsi14.toFixed(0)} (sobrecompra)`); }
  }
  if (q.volumeRatio && q.volumeRatio > 1.8 && (q.change1d ?? 0) > 0) { s += 5; reasons.push("entrada de volumen"); }
  // Penaliza volatilidad extrema
  if (q.vol30 && q.vol30 > 1.2) s -= 6;
  const { history, triggers, ...rest } = q;
  scored.push({ ...rest, country: country[q.symbol] || "", score: Math.round(clamp(s, 0, 100)), reasons, spark: history.slice(-90).map((h) => h[1]) });
}
scored.sort((a, b) => b.score - a.score);
mkdirSync(join(ROOT, "out"), { recursive: true });
const result = { at, analyzed: scored.length, failed: rows.filter((r) => r?.error).map((r) => r.symbol), top: scored.slice(0, top) };
writeFileSync(join(ROOT, "out", "scan-candidates.json"), JSON.stringify(result));
// Documento listo para la dashboard (solo técnico); merge-scan.mjs le añade noticias y veredicto
writeFileSync(join(ROOT, "out", "scan-latest.json"), JSON.stringify({ at, analyzed: result.analyzed, items: result.top.map((t) => ({ ...t, reason: t.reasons.join("; ") })) }));
console.log(JSON.stringify({ ...result, top: result.top.map(({ spark, ...r }) => r) }, null, 1));
