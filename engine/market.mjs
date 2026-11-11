// Uso: node engine/market.mjs NVDA BTC-EUR ...
// Escribe un documento por símbolo en out/quotes/<id>.json (listo para la BD de la dashboard)
// y out/fx.json; imprime un resumen breve (sin historial) para el análisis.
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ROOT, analyze, fxEurPer, mapLimit } from "./lib.mjs";

const symbols = [...new Set(process.argv.slice(2).map((s) => s.trim().toUpperCase()).filter(Boolean))];
if (!symbols.length) {
  console.error("Indica al menos un símbolo, p. ej. NVDA BTC-EUR");
  process.exit(1);
}

const outDir = join(ROOT, "out", "quotes");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const at = new Date().toISOString();
const quotes = await mapLimit(symbols, 4, analyze);

const currencies = [...new Set(quotes.filter((q) => !q.error).map((q) => q.currency))];
const fx = { EUR: 1 };
for (const c of currencies) {
  try { fx[c] = await fxEurPer(c); } catch { fx[c] = null; }
}
writeFileSync(join(ROOT, "out", "fx.json"), JSON.stringify({ at, eurPer: fx }));

const brief = [];
for (const q of quotes) {
  if (q.error) { brief.push(q); continue; }
  const id = q.symbol.replace(/[^A-Za-z0-9_-]/g, "_");
  const doc = { ...q, eurPer: fx[q.currency] ?? null, priceEur: fx[q.currency] ? Math.round(q.price * fx[q.currency] * 100) / 100 : null, updatedAt: at };
  writeFileSync(join(outDir, `${id}.json`), JSON.stringify(doc));
  const { history, ...rest } = doc;
  brief.push({ docId: id, file: join(outDir, `${id}.json`), ...rest });
}
console.log(JSON.stringify({ at, fx, quotes: brief }, null, 1));
