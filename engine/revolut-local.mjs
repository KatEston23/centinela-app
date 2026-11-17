// Tarea del PC: comprueba qué acciones se pueden comprar en Revolut y lo sube a data/revolut.json.
// (Desde GitHub Actions la web de Revolut responde 403; desde casa, no.)
//   node engine/revolut-local.mjs
// Revisa: el universo del escáner, las listas de Yahoo de «Alto riesgo» y los símbolos que el motor
// manda a la IA (ai-request.json, público). Solo datos públicos: qué tickers ofrece Revolut.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { execSync } from "node:child_process";
import { ROOT, mapLimit } from "./lib.mjs";
import { UNIVERSE } from "./universe.mjs";
import { SCREENS, screener, usable } from "./movers.mjs";
import { checkRevolut, REV_FILE } from "./revolut.mjs";

const git = (a) => execSync("git " + a, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).toString().trim();
const now = new Date();
const prev = existsSync(REV_FILE) ? JSON.parse(readFileSync(REV_FILE, "utf8")) : { map: {} };
const s = { revolut: { ...prev.map } };

const syms = new Set(UNIVERSE.map((u) => u[0]).filter((x) => !/-(EUR|USD)$/.test(x)));
const lists = await mapLimit(SCREENS, 3, async (id) => { try { return await screener(id); } catch { return []; } });
for (const l of lists) for (const x of l.filter(usable)) syms.add(x.symbol);
try {
  git("fetch -q --depth=1 origin gh-pages");
  const req = JSON.parse(git("show FETCH_HEAD:ai-request.json"));
  for (const x of req.symbols || []) if (!/-(EUR|USD)$/.test(x.symbol)) syms.add(x.symbol);
} catch { /* sin petición publicada: basta con lo demás */ }

const r = await checkRevolut(s, [...syms], now, 400);
const map = Object.fromEntries(Object.entries(s.revolut).filter(([k, v]) => typeof v?.ok === "boolean" && !/-(EUR|USD)$/.test(k)).sort());
const changed = JSON.stringify(map) !== JSON.stringify(prev.map || {});
console.log(`Revolut: ${r.checked} fichas comprobadas, ${r.blocked} bloqueadas; ${Object.values(map).filter((v) => v.ok).length} disponibles de ${Object.keys(map).length}`);
if (!changed) process.exit(0);
mkdirSync(dirname(REV_FILE), { recursive: true });
writeFileSync(REV_FILE, JSON.stringify({ at: now.toISOString(), source: "revolut.com/en-GB/stocks", map }, null, 0) + "\n");
try {
  git("add data/revolut.json");
  git('-c user.name=Centinela -c user.email=centinela@users.noreply.github.com commit -q -m "Revolut: disponibilidad de acciones"');
  for (let i = 0; i < 3; i++) { try { git("pull -q --rebase --autostash origin main"); git("push -q origin main"); console.log("subido"); break; } catch (e) { if (i === 2) throw e; } }
} catch (e) { console.error("No se pudo subir: " + e.message); process.exit(1); }
