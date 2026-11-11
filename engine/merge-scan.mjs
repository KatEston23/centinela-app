// Uso: node engine/merge-scan.mjs out/scan-notes.json
// Mezcla el análisis de noticias de la rutina con out/scan-latest.json.
// scan-notes.json: { "SÍMBOLO": { verdict, confidence, score?, reason, news, risk }, ... }
// verdict: comprar | vigilar | mantener | reducir. Las candidatas analizadas van primero.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib.mjs";

// Opcional: --exclude=NVDA,BTC-EUR quita lo que ya está en cartera
const args = process.argv.slice(2);
const exclude = new Set((args.find((a) => a.startsWith("--exclude=")) || "--exclude=").slice(10).split(",").filter(Boolean).map((s) => s.toUpperCase()));
const notesPath = args.find((a) => !a.startsWith("--")) || join(ROOT, "out", "scan-notes.json");
const latestPath = join(ROOT, "out", "scan-latest.json");
const latest = JSON.parse(readFileSync(latestPath, "utf8"));
const notes = JSON.parse(readFileSync(notesPath, "utf8"));

const enriched = [], rest = [];
for (const it of latest.items) {
  if (exclude.has(it.symbol)) continue;
  const n = notes[it.symbol];
  if (n) enriched.push({ ...it, ...n, score: n.score ?? it.score });
  else rest.push(it);
}
enriched.sort((a, b) => b.score - a.score);
latest.items = [...enriched, ...rest].slice(0, 15);
latest.enrichedAt = new Date().toISOString();
writeFileSync(latestPath, JSON.stringify(latest));
console.log(`scan-latest.json: ${enriched.length} con noticias, ${latest.items.length} en total`);
