// Importa el extracto de cuenta del Robo-Advisor de Revolut al estado (out/state.json).
// Uso: node engine/state.mjs decrypt
//      node engine/import-robot.mjs <extracto.csv> [idDeDrive] [fechaDeDrive]
//      node engine/state.mjs publish "Robo-Advisor: extracto importado"
// Usa el mismo lector que el extracto de Invest. Cada importación sustituye a la anterior,
// así que conviene subir siempre el extracto completo (desde que se abrió el robot).
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { importRevolut, holdingsFromLedger } from "./parser.mjs";
import { readState, writeState } from "./state.mjs";
import { updateRobot } from "./robot.mjs";

const [file, driveFileId, driveModifiedTime] = process.argv.slice(2);
if (!file) { console.error("Indica el CSV del Robo-Advisor"); process.exit(1); }
const rows = importRevolut(readFileSync(file, "utf8"));
if (!rows.length) { console.error("El extracto no tiene movimientos"); process.exit(2); }
const s = readState();
s.robot = { ...(s.robot || {}), ledger: { rows, fileName: basename(file), driveFileId: driveFileId || null, driveModifiedTime: driveModifiedTime || null, importedAt: new Date().toISOString() } };
const R = await updateRobot(s, holdingsFromLedger);
writeState(s);
const e = (v) => (Math.round(v * 100) / 100).toLocaleString("es-ES") + " €";
console.log(`Movimientos: ${rows.length} · fondos: ${R.positions.length} (con precio: ${R.priced})`);
console.log(`Valor ${e(R.value)} · aportado ${e(R.invested)} · resultado ${e(R.pnl)} · efectivo ${e(R.cash)}`);
console.log("Por clase:", R.byClass.map((x) => `${x.name} ${(x.w * 100).toFixed(1)} %`).join(" · "));
console.log("Por región:", R.byRegion.map((x) => `${x.name} ${(x.w * 100).toFixed(1)} %`).join(" · "));
console.log("Movimientos:", R.moves.map((m) => `${m.d} ${m.kind}`).join(" | "));
if (R.bench) console.log(`Indexado (${R.bench.sym}): ${e(R.bench.value)}`);
for (const p of R.positions) console.log(`  ${p.t.padEnd(5)} ${String(p.sym).padEnd(9)} ${(p.weight * 100).toFixed(1).padStart(5)} % ${p.cls.padEnd(15)} ${p.region.padEnd(11)} ${p.name}`);
